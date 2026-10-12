import type { Implementation, RequestOptions } from '@modelcontextprotocol/client';
import type {
  CallToolRequest,
  CallToolResult,
  Prompt,
  Resource,
  ResourceTemplateType,
  ServerContext,
  Tool,
  ToolAnnotations,
  Transport,
} from '@modelcontextprotocol/server';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type {
  ActionRecord,
  ActionStore,
  Guard,
  GuardEvent,
  ToolAnnotations as GuardToolAnnotations,
} from 'twiceshy';
import {
  ConfigInvalidError,
  classifyError,
  classifyToolResult,
  createGuard,
  DownstreamUnavailableError,
  definiteFailure,
  isTwiceshyError,
  MemoryStore,
  shouldGuard,
  UnsupportedFeatureError,
} from 'twiceshy';
import { SqliteStore } from 'twiceshy/sqlite';
import type { ProxyConfig, ToolOptions } from './config.js';
import type { DownstreamConnection, DownstreamFailure, Downstreams } from './downstream.js';
import { connectAllDownstreams, listAllTools } from './downstream.js';
import { createLogger, type Logger, redirectConsoleToStderr } from './logger.js';
import { createSecretMasker } from './mask.js';
import { buildToolRouting, exposeName, type ToolNaming, type ToolRouting } from './naming.js';
import { PROXY_VERSION } from './version.js';

/**
 * The proxy (C13). It exposes one MCP server to the agent, forwards unguarded
 * calls untouched, sends guarded calls through the core guard with the
 * downstream server name as the namespace, and keeps the agent informed about
 * progress, cancellation, tool changes, and server failures.
 */

/** The `_meta` key that carries Twiceshy's duplicate outcome (C8). */
const OUTCOME_META_KEY = 'dev.twiceshy/outcome';

/** How long shutdown waits for in-flight calls (C13). */
const SHUTDOWN_LIMIT_MS = 10_000;

export interface ProxyOptions {
  config: ProxyConfig;
  logger?: Logger;
  clientInfo?: Implementation;
  /** Pre-connected downstreams for tests; skips spawning configured servers. */
  downstreams?: Downstreams;
}

export interface ProxyHandle {
  readonly server: Server;
  readonly connections: readonly DownstreamConnection[];
  readonly failures: readonly DownstreamFailure[];
  /** The shared action store, exposed for status and tests. */
  readonly store: ActionStore;
  /** The merged tool list exactly as `tools/list` reports it. */
  exposedTools(): Tool[];
  close(): Promise<void>;
}

/** The durable outcome object stored under `_meta["dev.twiceshy/outcome"]`. */
export interface DuplicateOutcomeMeta {
  status: 'duplicate';
  recordId: string;
  fingerprint: string;
  originalAt: string | null;
  /** True when redaction replaced at least one field of the stored result (C20 rule 6). */
  resultRedacted: boolean;
}

interface ToolRoute {
  connection: DownstreamConnection;
  toolName: string;
  tool: Tool;
}

interface ResourceRoute {
  connection: DownstreamConnection;
  resource: Resource;
}

interface PromptRoute {
  connection: DownstreamConnection;
  prompt: Prompt;
}

interface ProxyTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown> };
  annotations: ToolAnnotations;
  call(): Promise<CallToolResult>;
}

/**
 * Carries a downstream `isError: true` result through the guard so the record
 * is classified per C7, while the caller still receives the original result.
 */
class DownstreamToolError extends Error {
  readonly result: CallToolResult;

  constructor(message: string, result: CallToolResult) {
    super(message);
    this.name = 'DownstreamToolError';
    this.result = result;
  }
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** C20 rule 5: raw error text is logged only at debug level. */
function safeErrorText(logger: Logger, cause: unknown): string {
  if (logger.level === 'debug') {
    return describeError(cause);
  }
  return cause instanceof Error ? cause.name : typeof cause;
}

function toolText(text: string, isError = false): CallToolResult {
  return isError
    ? { isError: true, content: [{ type: 'text', text }] }
    : { content: [{ type: 'text', text }] };
}

/** C8: blocked calls are tool errors, never protocol errors. */
function blockedResult(error: { what: string; why: string; fix: string }): CallToolResult {
  return toolText(
    `Twiceshy blocked this call.\n${error.what}\nWhy: ${error.why}\nFix: ${error.fix}`,
    true,
  );
}

/** C13: a call to a crashed or unavailable server is a clean tool error. */
function downstreamUnavailable(serverName: string, cause: unknown): CallToolResult {
  const error = new DownstreamUnavailableError({ server: serverName, cause });
  return toolText(
    `Twiceshy blocked this call.\n${error.what}\nWhy: ${error.why}\nFix: ${error.fix}`,
    true,
  );
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** The `14:02:11` part of the C8 duplicate wording, in UTC. */
function formatUtcTime(date: Date): string {
  return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;
}

/**
 * C8 duplicate result: the original stored result unchanged, `_meta` added,
 * optional text block. When `storeResult: false` kept no result, the duplicate
 * is a short text summary saying the action already ran (C20 rule 6).
 */
export function duplicateResult(
  original: CallToolResult | undefined,
  record: ActionRecord,
  originalAt: Date | null,
  annotateDuplicates: boolean,
): CallToolResult {
  const outcome: DuplicateOutcomeMeta = {
    status: 'duplicate',
    recordId: record.id,
    fingerprint: record.fingerprint,
    originalAt: originalAt === null ? null : originalAt.toISOString(),
    resultRedacted: record.resultRedacted,
  };
  if (original === undefined || (record.resultTruncated && record.result === undefined)) {
    const when = formatUtcTime(originalAt ?? record.completedAt ?? new Date());
    return {
      content: [
        {
          type: 'text',
          text:
            `Twiceshy: this action already ran at ${when} UTC and was not repeated. ` +
            'No result was stored for it, so the original result cannot be shown. ' +
            'If the user really wants it done again, ask them to confirm, then tell them a person must approve the repeat.',
        },
      ],
      _meta: { [OUTCOME_META_KEY]: outcome },
    };
  }
  const withMeta: CallToolResult = {
    ...original,
    _meta: { ...original._meta, [OUTCOME_META_KEY]: outcome },
  };
  if (!annotateDuplicates) {
    return withMeta;
  }
  const when = formatUtcTime(originalAt ?? record.completedAt ?? new Date());
  const note =
    `Twiceshy: this action already ran at ${when} UTC and was not repeated. ` +
    'The original result follows. If the user really wants it done again, ask them to confirm, ' +
    'then tell them a person must approve the repeat.';
  return { ...withMeta, content: [{ type: 'text', text: note }, ...original.content] };
}

export function createActionStore(config: ProxyConfig['store'], logger: Logger): ActionStore {
  if (config.type === 'sqlite') {
    logger.info(`using SQLite store at ${config.path}`);
    return new SqliteStore({ path: config.path });
  }
  return new MemoryStore();
}

function toolOptionsFor(config: ProxyConfig, serverName: string, toolName: string): ToolOptions {
  return config.mcpServers[serverName]?.tools[toolName] ?? {};
}

/** Narrows SDK annotations (optional-with-undefined) to the core guard's shape. */
export function guardAnnotations(tool: Tool): GuardToolAnnotations | null {
  const annotations = tool.annotations;
  if (annotations === undefined || annotations === null) {
    return null;
  }
  return {
    ...(annotations.readOnlyHint === undefined ? {} : { readOnlyHint: annotations.readOnlyHint }),
    ...(annotations.destructiveHint === undefined
      ? {}
      : { destructiveHint: annotations.destructiveHint }),
    ...(annotations.idempotentHint === undefined
      ? {}
      : { idempotentHint: annotations.idempotentHint }),
    ...(annotations.openWorldHint === undefined
      ? {}
      : { openWorldHint: annotations.openWorldHint }),
  };
}

function toProxyTool(tool: ProxyTool): Tool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as Tool['inputSchema'],
    annotations: tool.annotations,
  };
}

/**
 * C20 rule 5: below debug, an event carries only the error's class name,
 * Twiceshy code, and classification. The full downstream message is written
 * only at debug, where the docs warn it may contain downstream text.
 */
function safeErrorField(logger: Logger, event: GuardEvent): unknown {
  if (event.error === undefined) {
    return undefined;
  }
  if (logger.level === 'debug') {
    return event.error;
  }
  const name = event.error instanceof Error ? event.error.name : typeof event.error;
  const code = isTwiceshyError(event.error) ? event.error.code : undefined;
  const classification =
    event.reason === 'definite' || event.reason === 'ambiguous'
      ? event.reason
      : classifyError(event.error).classification;
  return {
    name,
    classification,
    ...(code === undefined ? {} : { code }),
  };
}

/** One structured JSON line per guard event, at the C15-recommended level. */
function logGuardEvent(logger: Logger, event: GuardEvent): void {
  const child = logger.child(event.server);
  const fields =
    event.error === undefined ? { ...event } : { ...event, error: safeErrorField(logger, event) };
  switch (event.type) {
    case 'execute':
      child.debug(`executed ${event.tool}`, fields);
      break;
    case 'duplicate':
      child.info(`duplicate ${event.tool}`, fields);
      break;
    case 'blocked':
      child.warn(`blocked ${event.tool}`, fields);
      break;
    case 'in-doubt':
      child.warn(`in doubt ${event.tool}`, fields);
      break;
    case 'late-completion':
      child.info(`late completion ${event.tool}`, fields);
      break;
    case 'resolution-conflict':
      child.error(`resolution conflict for ${event.tool}`, fields);
      break;
    case 'store-write-failed':
      child.error(`store write failed for ${event.tool}`, fields);
      break;
    case 'guard-bypassed':
      child.warn(`guard bypassed for ${event.tool}`, fields);
      break;
    case 'warning':
      child.warn(`warning for ${event.tool}`, fields);
      break;
  }
}

function unsupportedFeature(feature: 'sampling' | 'elicitation'): UnsupportedFeatureError {
  return new UnsupportedFeatureError({ feature });
}

/** Forwarding options: progress notifications and cancellation (C13). */
function requestOptions(
  progressToken: string | number | undefined,
  ctx: ServerContext | undefined,
): RequestOptions {
  const options: RequestOptions = {};
  if (ctx !== undefined && progressToken !== undefined) {
    options.onprogress = (progress) => {
      void ctx.mcpReq.notify({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress: progress.progress,
          ...(progress.total === undefined ? {} : { total: progress.total }),
          ...(progress.message === undefined ? {} : { message: progress.message }),
        },
      });
    };
  }
  if (ctx !== undefined) {
    options.signal = ctx.mcpReq.signal;
  }
  return options;
}

async function waitForActiveCalls(
  activeCalls: ReadonlySet<Promise<unknown>>,
  limitMs: number,
): Promise<void> {
  if (activeCalls.size === 0) {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, limitMs);
  });
  try {
    await Promise.race([Promise.allSettled([...activeCalls]).then(() => undefined), limit]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export async function createProxy(options: ProxyOptions): Promise<ProxyHandle> {
  const logger = options.logger ?? createLogger();
  const naming: ToolNaming = options.config.toolNaming;
  let serverRef: Server | undefined;

  const downstreams =
    options.downstreams ??
    (await connectAllDownstreams(options.config.mcpServers, {
      logger,
      maskSecrets: createSecretMasker(options.config.resolvedEnvValues),
      ...(options.clientInfo === undefined ? {} : { clientInfo: options.clientInfo }),
      onRestarted: async (connection) => {
        if (serverRef === undefined) {
          return;
        }
        rebuildRouting();
        logger.child(connection.name).info('surfaces refreshed after restart');
        await serverRef.sendToolListChanged();
        await serverRef.sendResourceListChanged();
        await serverRef.sendPromptListChanged();
      },
    }));

  let routing: ToolRouting;
  try {
    routing = buildToolRouting(downstreams.connections, naming);
  } catch (cause) {
    await downstreams.close();
    throw cause;
  }

  const store = createActionStore(options.config.store, logger);
  const guards = new Map<string, Guard>();
  for (const connection of downstreams.connections) {
    guards.set(
      connection.name,
      createGuard({
        store,
        namespace: connection.name,
        window: options.config.windowMs,
        retention: options.config.retentionMs,
        onStoreFailure: options.config.onStoreFailure,
        trustIdempotentHint: options.config.trustIdempotentHint,
        // The proxy owns the shared store and closes it once, after all guards.
        closeStore: false,
        // C13: shutdown waits up to 10 s for in-flight calls.
        closeTimeoutMs: SHUTDOWN_LIMIT_MS,
        hooks: {
          onExecute: (event) => logGuardEvent(logger, event),
          onDuplicate: (event) => logGuardEvent(logger, event),
          onBlocked: (event) => logGuardEvent(logger, event),
          onInDoubt: (event) => logGuardEvent(logger, event),
          onLateCompletion: (event) => logGuardEvent(logger, event),
          onResolutionConflict: (event) => logGuardEvent(logger, event),
          onStoreWriteFailed: (event) => logGuardEvent(logger, event),
          onGuardBypassed: (event) => logGuardEvent(logger, event),
          onWarning: (event) => logGuardEvent(logger, event),
        },
      }),
    );
  }

  const connectionByName = new Map(
    downstreams.connections.map((connection) => [connection.name, connection] as const),
  );
  const routes = new Map<string, ToolRoute>();
  const resourceByUri = new Map<string, ResourceRoute>();
  const promptByName = new Map<string, PromptRoute>();
  let exposed: Tool[] = [];
  let exposedResources: Resource[] = [];
  let exposedResourceTemplates: ResourceTemplateType[] = [];
  let exposedPrompts: Prompt[] = [];

  const rebuildRouting = (): void => {
    routing = buildToolRouting(downstreams.connections, naming);
    routes.clear();
    const tools: Tool[] = [];
    for (const entry of routing.entries) {
      const connection = connectionByName.get(entry.server);
      if (connection === undefined) {
        continue;
      }
      const tool = connection.tools.find((candidate) => candidate.name === entry.toolName);
      if (tool === undefined) {
        continue;
      }
      routes.set(entry.exposedName, { connection, toolName: entry.toolName, tool });
      // Spread keeps description, inputSchema, annotations, and _meta exactly.
      tools.push({ ...tool, name: entry.exposedName });
    }
    exposed = tools;

    resourceByUri.clear();
    const resources: Resource[] = [];
    for (const connection of downstreams.connections) {
      for (const resource of connection.resources) {
        if (resourceByUri.has(resource.uri)) {
          throw new ConfigInvalidError({
            issues: [
              `the resource "${resource.uri}" is exposed by both "${resourceByUri.get(resource.uri)?.connection.name}" and "${connection.name}"; rename one server or resource`,
            ],
          });
        }
        resourceByUri.set(resource.uri, { connection, resource });
        resources.push({ ...resource, name: exposeName(connection.name, resource.name, naming) });
      }
    }
    exposedResources = resources;

    exposedResourceTemplates = downstreams.connections.flatMap((connection) =>
      connection.resourceTemplates.map((template) => ({
        ...template,
        name: exposeName(connection.name, template.name, naming),
      })),
    );

    promptByName.clear();
    const prompts: Prompt[] = [];
    for (const connection of downstreams.connections) {
      for (const prompt of connection.prompts) {
        const exposedName = exposeName(connection.name, prompt.name, naming);
        if (promptByName.has(exposedName)) {
          throw new ConfigInvalidError({
            issues: [
              `the prompt "${exposedName}" comes from both "${promptByName.get(exposedName)?.connection.name}" and "${connection.name}"; rename one of the prompts or servers`,
            ],
          });
        }
        promptByName.set(exposedName, { connection, prompt });
        prompts.push({ ...prompt, name: exposedName });
      }
    }
    exposedPrompts = prompts;
  };

  rebuildRouting();

  const guardedCount = (connection: DownstreamConnection): number =>
    connection.tools.filter(
      (tool) =>
        shouldGuard(
          { name: tool.name, annotations: guardAnnotations(tool) },
          {
            ...(toolOptionsFor(options.config, connection.name, tool.name).guard === undefined
              ? {}
              : { guard: toolOptionsFor(options.config, connection.name, tool.name).guard }),
            trustIdempotentHint: options.config.trustIdempotentHint,
          },
        ).guarded,
    ).length;

  const proxyTools: ProxyTool[] = [
    {
      name: 'twiceshy_status',
      description:
        'Read-only. Shows which downstream servers are connected, how many tools are guarded, and how many records are in doubt.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      call: async () => {
        const lines = ['twiceshy status'];
        for (const connection of downstreams.connections) {
          lines.push(
            `  ${connection.name}: ${connection.status}, ${connection.tools.length} tools (${guardedCount(connection)} guarded)`,
          );
        }
        for (const failure of downstreams.failures) {
          lines.push(
            `  ${failure.name}: FAILED — ${failure.what} Why: ${failure.why} Fix: ${failure.fix}`,
          );
        }
        const inDoubt = await store.list({ state: 'IN_DOUBT' });
        lines.push(`  records in doubt: ${inDoubt.length}`);
        return toolText(lines.join('\n'));
      },
    },
  ];
  if (options.config.exposeRecentActions) {
    proxyTools.push({
      name: 'twiceshy_recent_actions',
      description: 'Read-only. Lists recent guarded actions with redacted arguments.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      call: async () => {
        const records = await store.list({ limit: 20 });
        if (records.length === 0) {
          return toolText('No recent guarded actions.');
        }
        const lines = records.map(
          (record) =>
            `${record.createdAt.toISOString()} ${record.serverId}/${record.toolName} ${record.state} args=${JSON.stringify(record.redactedArgs ?? null)}`,
        );
        return toolText(lines.join('\n'));
      },
    });
  }

  const proxyToolByName = new Map<string, ProxyTool>();
  for (const tool of proxyTools) {
    if (routing.byExposedName.has(tool.name) || promptByName.has(tool.name)) {
      throw new ConfigInvalidError({
        issues: [
          `toolNaming "${naming}": the built-in tool "${tool.name}" collides with a downstream surface; rename the downstream tool or server`,
        ],
      });
    }
    proxyToolByName.set(tool.name, tool);
  }

  const server = new Server(
    { name: 'twiceshy', version: PROXY_VERSION },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true, subscribe: false },
        prompts: { listChanged: true },
        logging: {},
      },
    },
  );
  serverRef = server;

  const activeCalls = new Set<Promise<unknown>>();
  let closing = false;

  server.setRequestHandler('tools/list', async () => ({
    tools: [...exposed, ...proxyTools.map(toProxyTool)],
  }));

  server.setRequestHandler('resources/list', async () => ({ resources: exposedResources }));

  server.setRequestHandler('resources/templates/list', async () => ({
    resourceTemplates: exposedResourceTemplates,
  }));

  server.setRequestHandler('resources/read', async (request) => {
    const route = resourceByUri.get(request.params.uri);
    if (route === undefined) {
      throw new Error(
        `Twiceshy: no configured server exposes the resource "${request.params.uri}".`,
      );
    }
    return route.connection.client.readResource({ uri: route.resource.uri });
  });

  server.setRequestHandler('prompts/list', async () => ({ prompts: exposedPrompts }));

  server.setRequestHandler('prompts/get', async (request) => {
    const route = promptByName.get(request.params.name);
    if (route === undefined) {
      throw new Error(
        `Twiceshy: no configured server exposes the prompt "${request.params.name}".`,
      );
    }
    return route.connection.client.getPrompt({
      name: route.prompt.name,
      ...(request.params.arguments === undefined ? {} : { arguments: request.params.arguments }),
    });
  });

  // Sampling and elicitation from downstream servers are refused (C13); the
  // handlers live on the client side, where those server-to-client requests
  // arrive. Registered with the other downstream handlers below.

  const forwardCall = async (
    route: ToolRoute,
    request: CallToolRequest,
    ctx: ServerContext,
  ): Promise<CallToolResult> =>
    route.connection.callTool(
      {
        name: route.toolName,
        ...(request.params.arguments === undefined ? {} : { arguments: request.params.arguments }),
        ...(request.params._meta === undefined ? {} : { _meta: request.params._meta }),
      },
      requestOptions(request.params._meta?.progressToken, ctx),
    );

  /** Guarded call: classify a downstream `isError` result before it is stored. */
  const callGuarded = async (
    route: ToolRoute,
    request: CallToolRequest,
    ctx: ServerContext,
    toolOptions: ToolOptions,
  ): Promise<CallToolResult> => {
    const result = await forwardCall(route, request, ctx);
    const classification = classifyToolResult(result, {
      treatToolErrorsAsDefinite: toolOptions.treatToolErrorsAsDefinite ?? false,
    });
    if (classification === null) {
      return result;
    }
    const failure = new DownstreamToolError(
      `The tool "${route.toolName}" on server "${route.connection.name}" returned isError: true.`,
      result,
    );
    throw classification === 'definite' ? definiteFailure(failure) : failure;
  };

  const handleCall = async (
    request: CallToolRequest,
    ctx: ServerContext,
  ): Promise<CallToolResult> => {
    const name = request.params.name;
    const proxyTool = proxyToolByName.get(name);
    if (proxyTool !== undefined) {
      return proxyTool.call();
    }
    const route = routes.get(name);
    if (route === undefined) {
      return toolText(
        `Twiceshy: unknown tool "${name}". It is not provided by any configured server.`,
        true,
      );
    }

    const toolOptions = toolOptionsFor(options.config, route.connection.name, route.toolName);
    const decision = shouldGuard(
      { name: route.toolName, annotations: guardAnnotations(route.tool) },
      {
        ...(toolOptions.guard === undefined ? {} : { guard: toolOptions.guard }),
        trustIdempotentHint: options.config.trustIdempotentHint,
      },
    );
    const guard = guards.get(route.connection.name);
    if (!decision.guarded || guard === undefined) {
      // C3: unguarded calls forward untouched and create no record.
      try {
        return await forwardCall(route, request, ctx);
      } catch (cause) {
        return downstreamUnavailable(route.connection.name, cause);
      }
    }

    try {
      const outcome = await guard.run(
        {
          tool: route.toolName,
          args: request.params.arguments ?? {},
          signal: ctx.mcpReq.signal,
          ...(toolOptions.keyFields === undefined ? {} : { keyFields: toolOptions.keyFields }),
          ...(toolOptions.ignoreFields === undefined
            ? {}
            : { ignoreFields: toolOptions.ignoreFields }),
          ...(toolOptions.normalize === undefined ? {} : { normalize: toolOptions.normalize }),
          ...(toolOptions.timeoutMs === undefined ? {} : { timeoutMs: toolOptions.timeoutMs }),
          ...(toolOptions.storeResult === undefined
            ? {}
            : { storeResult: toolOptions.storeResult }),
        },
        () => callGuarded(route, request, ctx, toolOptions),
      );
      if (outcome.status === 'duplicate') {
        return duplicateResult(
          outcome.value,
          outcome.record,
          outcome.originalAt,
          options.config.annotateDuplicates,
        );
      }
      return outcome.value;
    } catch (cause) {
      if (cause instanceof DownstreamToolError) {
        // The tool ran and reported failure: the caller gets its original result.
        return cause.result;
      }
      if (isTwiceshyError(cause)) {
        return blockedResult(cause);
      }
      return downstreamUnavailable(route.connection.name, cause);
    }
  };

  server.setRequestHandler('tools/call', async (request, ctx) => {
    if (closing) {
      return toolText('Twiceshy is shutting down and is not accepting new calls.', true);
    }
    const call = handleCall(request, ctx);
    activeCalls.add(call);
    try {
      return await call;
    } finally {
      activeCalls.delete(call);
    }
  });

  const refreshTools = async (connection: DownstreamConnection): Promise<void> => {
    const child = logger.child(connection.name);
    try {
      connection.tools = await listAllTools(connection.client, 15_000);
      rebuildRouting();
      await server.sendToolListChanged();
      child.info(`tool list changed; now ${connection.tools.length} tool(s)`);
    } catch (cause) {
      child.error(`could not refresh the tool list: ${safeErrorText(child, cause)}`);
    }
  };

  const refreshResources = async (connection: DownstreamConnection): Promise<void> => {
    try {
      connection.resources =
        connection.client.getServerCapabilities()?.resources === undefined
          ? []
          : await listSurfaceResources(connection);
      rebuildRouting();
      await server.sendResourceListChanged();
    } catch (cause) {
      const child = logger.child(connection.name);
      child.error(`could not refresh resources: ${safeErrorText(child, cause)}`);
    }
  };

  const refreshPrompts = async (connection: DownstreamConnection): Promise<void> => {
    try {
      connection.prompts =
        connection.client.getServerCapabilities()?.prompts === undefined
          ? []
          : await listSurfacePrompts(connection);
      rebuildRouting();
      await server.sendPromptListChanged();
    } catch (cause) {
      const child = logger.child(connection.name);
      child.error(`could not refresh prompts: ${safeErrorText(child, cause)}`);
    }
  };

  for (const connection of downstreams.connections) {
    connection.client.setNotificationHandler('notifications/tools/list_changed', () =>
      refreshTools(connection),
    );
    connection.client.setNotificationHandler('notifications/resources/list_changed', () =>
      refreshResources(connection),
    );
    connection.client.setNotificationHandler('notifications/prompts/list_changed', () =>
      refreshPrompts(connection),
    );
    connection.client.setNotificationHandler(
      'notifications/resources/updated',
      async (notification) => {
        await server.sendResourceUpdated(notification.params);
      },
    );
    connection.client.setNotificationHandler('notifications/message', async (notification) => {
      await server.sendLoggingMessage(notification.params);
    });
    // Sampling and elicitation from this server are refused with a clear
    // message naming the feature and the v1.1 plan (C13).
    connection.client.setRequestHandler('sampling/createMessage', async () => {
      throw unsupportedFeature('sampling');
    });
    connection.client.setRequestHandler('elicitation/create', async () => {
      throw unsupportedFeature('elicitation');
    });
  }

  logger.info(
    `proxy ready: ${downstreams.connections.length} server(s) connected, ${downstreams.failures.length} failed`,
  );

  return {
    server,
    connections: downstreams.connections,
    failures: downstreams.failures,
    store,
    exposedTools: () => exposed,
    close: async () => {
      closing = true;
      await waitForActiveCalls(activeCalls, SHUTDOWN_LIMIT_MS);
      await Promise.all([...guards.values()].map((guard) => guard.close().catch(() => undefined)));
      await downstreams.close();
      await store.close();
      try {
        await server.close();
      } catch (cause) {
        logger.warn(`closing the proxy server failed: ${describeError(cause)}`);
      }
    },
  };
}

/** Re-reads a connection's resources, treating an absent surface as empty. */
async function listSurfaceResources(connection: DownstreamConnection): Promise<Resource[]> {
  try {
    return (await connection.client.listResources()).resources;
  } catch {
    return [];
  }
}

/** Re-reads a connection's prompts, treating an absent surface as empty. */
async function listSurfacePrompts(connection: DownstreamConnection): Promise<Prompt[]> {
  try {
    return (await connection.client.listPrompts()).prompts;
  } catch {
    return [];
  }
}

/**
 * Creates the proxy and serves it on stdio, which is how the agent's client
 * launches it. Tests and other embeddings pass an explicit transport.
 */
export async function startProxy(
  options: ProxyOptions,
  transport?: Transport,
): Promise<ProxyHandle> {
  const logger = options.logger ?? createLogger();
  // stdout carries MCP messages only: any SDK console output goes to stderr.
  redirectConsoleToStderr(logger);
  const handle = await createProxy({ ...options, logger });
  try {
    await handle.server.connect(transport ?? new StdioServerTransport());
  } catch (cause) {
    await handle.close();
    throw cause;
  }
  return handle;
}
