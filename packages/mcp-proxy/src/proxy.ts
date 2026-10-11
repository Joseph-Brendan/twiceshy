import type { Implementation } from '@modelcontextprotocol/client';
import type {
  CallToolRequest,
  CallToolResult,
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
  ToolAnnotations as GuardToolAnnotations,
} from 'twiceshy';
import {
  ConfigInvalidError,
  classifyToolResult,
  createGuard,
  definiteFailure,
  isTwiceshyError,
  MemoryStore,
  shouldGuard,
} from 'twiceshy';
import { SqliteStore } from 'twiceshy/sqlite';
import type { ProxyConfig, ToolOptions } from './config.js';
import type { DownstreamConnection, DownstreamFailure, Downstreams } from './downstream.js';
import { connectAllDownstreams, listAllTools } from './downstream.js';
import { createLogger, type Logger } from './logger.js';
import { buildToolRouting, type ToolRouting } from './naming.js';
import { PROXY_VERSION } from './version.js';

/**
 * The proxy (C13). It exposes one MCP server to the agent, forwards unguarded
 * calls untouched, and sends guarded calls through the core guard with the
 * downstream server name as the namespace.
 */

/** The `_meta` key that carries Twiceshy's duplicate outcome (C8). */
const OUTCOME_META_KEY = 'dev.twiceshy/outcome';

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
}

interface ToolRoute {
  connection: DownstreamConnection;
  toolName: string;
  tool: Tool;
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

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** The `14:02:11` part of the C8 duplicate wording, in UTC. */
function formatUtcTime(date: Date): string {
  return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;
}

/** C8 duplicate result: original unchanged, `_meta` added, optional text block. */
export function duplicateResult(
  original: CallToolResult,
  record: ActionRecord,
  originalAt: Date | null,
  annotateDuplicates: boolean,
): CallToolResult {
  const outcome: DuplicateOutcomeMeta = {
    status: 'duplicate',
    recordId: record.id,
    fingerprint: record.fingerprint,
    originalAt: originalAt === null ? null : originalAt.toISOString(),
  };
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

function createActionStore(config: ProxyConfig['store'], logger: Logger): ActionStore {
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
function guardAnnotations(tool: Tool): GuardToolAnnotations | null {
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

export async function createProxy(options: ProxyOptions): Promise<ProxyHandle> {
  const logger = options.logger ?? createLogger();
  const downstreams =
    options.downstreams ??
    (await connectAllDownstreams(options.config.mcpServers, {
      logger,
      ...(options.clientInfo === undefined ? {} : { clientInfo: options.clientInfo }),
    }));

  let routing: ToolRouting;
  try {
    routing = buildToolRouting(downstreams.connections, options.config.toolNaming);
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
        hooks: {
          onInDoubt: (event) =>
            logger
              .child(event.server)
              .warn(
                `record ${event.recordId ?? 'unknown'} is in doubt (${event.reason ?? event.type})`,
              ),
          onStoreWriteFailed: (event) =>
            logger
              .child(event.server)
              .error(
                `could not write record ${event.recordId ?? 'unknown'}: ${describeError(event.error)}`,
              ),
        },
      }),
    );
  }

  const connectionByName = new Map(
    downstreams.connections.map((connection) => [connection.name, connection] as const),
  );
  const routes = new Map<string, ToolRoute>();
  const collectExposedTools = (): Tool[] => {
    routes.clear();
    const exposed: Tool[] = [];
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
      exposed.push({ ...tool, name: entry.exposedName });
    }
    return exposed;
  };

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
            `  ${connection.name}: connected, ${connection.tools.length} tools (${guardedCount(connection)} guarded)`,
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
    if (routing.byExposedName.has(tool.name)) {
      throw new ConfigInvalidError({
        issues: [
          `toolNaming "${options.config.toolNaming}": the built-in tool "${tool.name}" collides with a downstream tool; rename the downstream tool or server`,
        ],
      });
    }
    proxyToolByName.set(tool.name, tool);
  }

  let exposed = collectExposedTools();

  const server = new Server(
    { name: 'twiceshy', version: PROXY_VERSION },
    { capabilities: { tools: { listChanged: true } } },
  );

  server.setRequestHandler('tools/list', async () => ({
    tools: [...exposed, ...proxyTools.map(toProxyTool)],
  }));

  const forwardCall = async (route: ToolRoute, request: CallToolRequest): Promise<CallToolResult> =>
    route.connection.client.callTool({
      name: route.toolName,
      ...(request.params.arguments === undefined ? {} : { arguments: request.params.arguments }),
      ...(request.params._meta === undefined ? {} : { _meta: request.params._meta }),
    });

  /** Guarded call: classify a downstream `isError` result before it is stored. */
  const callGuarded = async (
    route: ToolRoute,
    request: CallToolRequest,
    toolOptions: ToolOptions,
  ): Promise<CallToolResult> => {
    const result = await forwardCall(route, request);
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

  server.setRequestHandler('tools/call', async (request) => {
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
        return await forwardCall(route, request);
      } catch (cause) {
        return toolText(
          `Twiceshy: the downstream server "${route.connection.name}" failed while calling "${route.toolName}": ${describeError(cause)}`,
          true,
        );
      }
    }

    try {
      const outcome = await guard.run(
        {
          tool: route.toolName,
          args: request.params.arguments ?? {},
          ...(toolOptions.keyFields === undefined ? {} : { keyFields: toolOptions.keyFields }),
          ...(toolOptions.ignoreFields === undefined
            ? {}
            : { ignoreFields: toolOptions.ignoreFields }),
          ...(toolOptions.normalize === undefined ? {} : { normalize: toolOptions.normalize }),
          ...(toolOptions.timeoutMs === undefined ? {} : { timeoutMs: toolOptions.timeoutMs }),
        },
        () => callGuarded(route, request, toolOptions),
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
      return toolText(
        `Twiceshy: the downstream server "${route.connection.name}" failed while calling "${route.toolName}": ${describeError(cause)}`,
        true,
      );
    }
  });

  const refreshTools = async (connection: DownstreamConnection): Promise<void> => {
    const child = logger.child(connection.name);
    try {
      connection.tools = await listAllTools(connection.client, 15_000);
      routing = buildToolRouting(downstreams.connections, options.config.toolNaming);
      exposed = collectExposedTools();
      await server.sendToolListChanged();
      child.info(`tool list changed; now ${connection.tools.length} tool(s)`);
    } catch (cause) {
      child.error(`could not refresh the tool list: ${describeError(cause)}`);
    }
  };

  for (const connection of downstreams.connections) {
    connection.client.setNotificationHandler('notifications/tools/list_changed', () =>
      refreshTools(connection),
    );
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

/**
 * Creates the proxy and serves it on stdio, which is how the agent's client
 * launches it. Tests and other embeddings pass an explicit transport.
 */
export async function startProxy(
  options: ProxyOptions,
  transport?: Transport,
): Promise<ProxyHandle> {
  const handle = await createProxy(options);
  try {
    await handle.server.connect(transport ?? new StdioServerTransport());
  } catch (cause) {
    await handle.close();
    throw cause;
  }
  return handle;
}
