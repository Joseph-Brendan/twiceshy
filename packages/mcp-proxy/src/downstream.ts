import type { Readable } from 'node:stream';
import type {
  CallToolRequestOptions,
  CallToolRequestParams,
  CallToolResult,
  Implementation,
  Prompt,
  Resource,
  ResourceTemplateType,
  Tool,
  Transport,
} from '@modelcontextprotocol/client';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { DownstreamUnavailableError } from 'twiceshy';
import type { ServerConfig } from './config.js';
import type { Logger } from './logger.js';
import { RestartScheduler } from './restart.js';

/**
 * Downstream connections (C13). One broken server never stops the others:
 * startup failures are recorded with what/why/fix, and a server that crashes
 * later is restarted with backoff while calls to it fail cleanly.
 */

export type ConnectionStatus = 'connected' | 'restarting' | 'failed' | 'closed';

export interface DownstreamConnection {
  readonly name: string;
  /** Replaced when the server restarts; always use `callTool` for calls. */
  readonly client: Client;
  tools: Tool[];
  resources: Resource[];
  resourceTemplates: ResourceTemplateType[];
  prompts: Prompt[];
  status: ConnectionStatus;
  failure: DownstreamFailure | null;
  callTool(
    params: CallToolRequestParams,
    options?: CallToolRequestOptions,
  ): Promise<CallToolResult>;
  close(): Promise<void>;
}

export interface DownstreamFailure {
  name: string;
  what: string;
  why: string;
  fix: string;
}

export interface Downstreams {
  connections: DownstreamConnection[];
  failures: DownstreamFailure[];
  close(): Promise<void>;
}

export interface ConnectDownstreamOptions {
  logger: Logger;
  clientInfo?: Implementation;
  connectTimeoutMs?: number;
  listingTimeoutMs?: number;
  /** Overrides the restart backoff schedule; tests use tiny delays. */
  restartDelaysMs?: readonly number[];
  /** Called after a successful restart so the proxy can refresh and notify. */
  onRestarted?: (connection: DownstreamConnection) => Promise<void> | void;
}

const DEFAULT_CLIENT_INFO: Implementation = { name: 'twiceshy', version: '0.0.0' };

function parentEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  return environment;
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Forwards child stderr to the proxy's logger with a server-name prefix. */
function forwardStderr(stream: Readable, logger: Logger): void {
  let buffer = '';
  const emitLine = (line: string): void => {
    if (line.trim().length > 0) {
      logger.stderr(line);
    }
  };
  stream.on('data', (chunk: Buffer | string) => {
    buffer += chunk.toString();
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      emitLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
    }
  });
  stream.on('end', () => {
    emitLine(buffer);
    buffer = '';
  });
}

/** Builds the transport for one configured server (stdio or Streamable HTTP). */
export function createDownstreamTransport(
  name: string,
  config: ServerConfig,
  logger: Logger,
): Transport {
  if (config.kind === 'stdio') {
    const transport = new StdioClientTransport({
      command: config.command,
      args: [...config.args],
      env: { ...parentEnvironment(), ...config.env },
      ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
      stderr: 'pipe',
    });
    const stderr = transport.stderr;
    if (stderr !== null) {
      forwardStderr(stderr as Readable, logger.child(name));
    }
    return transport;
  }
  return new StreamableHTTPClientTransport(new URL(config.url));
}

/**
 * Lists every tool of a connected server, following pagination to the end.
 * The no-argument call already aggregates pages; the loop keeps this correct
 * even if a single page comes back, and always ends on the last page.
 */
export async function listAllTools(client: Client, timeoutMs: number): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await client.listTools(cursor === undefined ? undefined : { cursor }, {
      timeout: timeoutMs,
    });
    tools.push(...page.tools);
    const next = page.nextCursor;
    if (next === undefined || next === null) {
      return tools;
    }
    cursor = next;
  }
}

/** Lists one surface, treating "this server does not offer it" as empty. */
async function listSurface<T>(
  label: string,
  load: () => Promise<T[]>,
  logger: Logger,
): Promise<T[]> {
  try {
    return await load();
  } catch (cause) {
    logger.debug(`${label} are not available: ${describeError(cause)}`);
    return [];
  }
}

class ManagedConnection implements DownstreamConnection {
  readonly name: string;
  client!: Client;
  tools: Tool[] = [];
  resources: Resource[] = [];
  resourceTemplates: ResourceTemplateType[] = [];
  prompts: Prompt[] = [];
  status: ConnectionStatus = 'restarting';
  failure: DownstreamFailure | null = null;

  private readonly config: ServerConfig;
  private readonly options: ConnectDownstreamOptions;
  private readonly failures: DownstreamFailure[];
  private scheduler: RestartScheduler | null = null;
  private closed = false;
  private restarting = false;

  constructor(
    name: string,
    config: ServerConfig,
    options: ConnectDownstreamOptions,
    failures: DownstreamFailure[],
  ) {
    this.name = name;
    this.config = config;
    this.options = options;
    this.failures = failures;
  }

  /** Initial connection; throws with a typed failure when it cannot start. */
  static async start(
    name: string,
    config: ServerConfig,
    options: ConnectDownstreamOptions,
    failures: DownstreamFailure[],
  ): Promise<ManagedConnection> {
    const connection = new ManagedConnection(name, config, options, failures);
    await connection.connect();
    return connection;
  }

  async callTool(
    params: CallToolRequestParams,
    options?: CallToolRequestOptions,
  ): Promise<CallToolResult> {
    return this.client.callTool(params, options);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.status = 'closed';
    this.scheduler?.stop();
    try {
      await this.client.close();
    } catch (cause) {
      this.options.logger
        .child(this.name)
        .warn(`closing the connection failed: ${describeError(cause)}`);
    }
  }

  private async connect(): Promise<void> {
    const client = new Client(this.options.clientInfo ?? DEFAULT_CLIENT_INFO, {
      capabilities: {
        sampling: {},
        elicitation: {},
      },
    });
    client.onclose = () => this.handleTransportClose();
    this.client = client;
    const transport = createDownstreamTransport(this.name, this.config, this.options.logger);
    await client.connect(transport, { timeout: this.options.connectTimeoutMs ?? 15_000 });
    await this.reloadSurfaces();
    this.status = 'connected';
    this.failure = null;
    this.restarting = false;
    this.options.logger
      .child(this.name)
      .info(
        `connected with ${this.tools.length} tool(s), ${this.resources.length} resource(s), ${this.prompts.length} prompt(s)`,
      );
  }

  private async reloadSurfaces(): Promise<void> {
    const timeout = this.options.listingTimeoutMs ?? 15_000;
    const logger = this.options.logger.child(this.name);
    const capabilities = this.client.getServerCapabilities();
    this.tools = capabilities?.tools === undefined ? [] : await listAllTools(this.client, timeout);
    this.resources =
      capabilities?.resources === undefined
        ? []
        : await listSurface(
            'resources',
            async () => (await this.client.listResources()).resources,
            logger,
          );
    this.resourceTemplates =
      capabilities?.resources === undefined
        ? []
        : await listSurface(
            'resource templates',
            async () => (await this.client.listResourceTemplates()).resourceTemplates,
            logger,
          );
    this.prompts =
      capabilities?.prompts === undefined
        ? []
        : await listSurface(
            'prompts',
            async () => (await this.client.listPrompts()).prompts,
            logger,
          );
  }

  private handleTransportClose(): void {
    if (this.closed || this.restarting) {
      return;
    }
    this.beginRestart();
  }

  private beginRestart(): void {
    this.restarting = true;
    this.status = 'restarting';
    const child = this.options.logger.child(this.name);
    child.warn('connection lost; restarting with backoff');
    this.scheduler = new RestartScheduler({
      tryRestart: () => this.tryReconnect(),
      ...(this.options.restartDelaysMs === undefined
        ? {}
        : { delaysMs: this.options.restartDelaysMs }),
      onGaveUp: () => {
        this.status = 'failed';
        const failure = this.failureFor(new Error('the restart attempts were exhausted'));
        this.failure = failure;
        if (!this.failures.some((existing) => existing.name === this.name)) {
          this.failures.push(failure);
        }
        child.error(`gave up after ${RESTART_SCHEDULER_ATTEMPTS} restart attempts`);
      },
      onScheduled: (attempt, delayMs) => {
        child.info(`restart attempt ${attempt} in ${delayMs}ms`);
      },
    });
    this.scheduler.start();
  }

  private async tryReconnect(): Promise<boolean> {
    const child = this.options.logger.child(this.name);
    try {
      await this.connect();
      child.info('reconnected');
      await this.options.onRestarted?.(this);
      return true;
    } catch (cause) {
      child.warn(`restart attempt failed: ${describeError(cause)}`);
      return false;
    }
  }

  private failureFor(cause: unknown): DownstreamFailure {
    const error = new DownstreamUnavailableError({ server: this.name, cause });
    return { name: this.name, what: error.what, why: error.why, fix: error.fix };
  }
}

/** Matches RESTART_DELAYS_MS length; kept here to avoid importing the array twice. */
const RESTART_SCHEDULER_ATTEMPTS = 5;

/**
 * Connects to one downstream server. Returns a typed failure instead of
 * throwing so the caller can keep starting the others (C13).
 */
export async function connectDownstream(
  name: string,
  config: ServerConfig,
  options: ConnectDownstreamOptions,
  failures: DownstreamFailure[],
): Promise<
  { ok: true; connection: DownstreamConnection } | { ok: false; failure: DownstreamFailure }
> {
  try {
    const connection = await ManagedConnection.start(name, config, options, failures);
    return { ok: true, connection };
  } catch (cause) {
    const error = new DownstreamUnavailableError({ server: name, cause });
    options.logger.error(`${error.what} Why: ${error.why} Fix: ${error.fix}`);
    return { ok: false, failure: { name, what: error.what, why: error.why, fix: error.fix } };
  }
}

/** Connects to every configured server, in parallel, isolating failures (C13). */
export async function connectAllDownstreams(
  servers: Readonly<Record<string, ServerConfig>>,
  options: ConnectDownstreamOptions,
): Promise<Downstreams> {
  const failures: DownstreamFailure[] = [];
  const results = await Promise.all(
    Object.entries(servers).map(([name, config]) =>
      connectDownstream(name, config, options, failures),
    ),
  );
  const connections: DownstreamConnection[] = [];
  for (const result of results) {
    if (result.ok) {
      connections.push(result.connection);
    } else {
      failures.push(result.failure);
    }
  }
  return {
    connections,
    failures,
    close: async () => {
      await Promise.all(connections.map((connection) => connection.close()));
    },
  };
}
