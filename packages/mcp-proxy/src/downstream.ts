import type { ChildProcess } from 'node:child_process';
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
import type { StdioServerParameters } from '@modelcontextprotocol/client/stdio';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
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
  /** The exact command line or URL that was tried. */
  target: string;
  targetKind: 'command' | 'url';
  /** Last lines the stdio server wrote to stderr, newest last. */
  stderr: string[];
}

/** Startup failure with the doctor-facing details attached. */
export class DownstreamStartupError extends Error {
  readonly failure: DownstreamFailure;

  constructor(failure: DownstreamFailure) {
    super(failure.what);
    this.name = 'DownstreamStartupError';
    this.failure = failure;
  }
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
  /** Masks known secret values in printed stderr and failure details (C20). */
  maskSecrets?: (text: string) => string;
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

/** C20 rule 5: raw error text is logged only at debug level. */
function describeErrorForLevel(logger: Logger, cause: unknown): string {
  return logger.level === 'debug' ? describeError(cause) : errorClassName(cause);
}

function errorClassName(cause: unknown): string {
  return cause instanceof Error ? cause.name : typeof cause;
}

/** Forwards child stderr to the proxy's logger with a server-name prefix. */
function forwardStderr(
  stream: Readable,
  logger: Logger,
  maskSecrets?: (text: string) => string,
): void {
  let buffer = '';
  const emitLine = (line: string): void => {
    if (line.trim().length > 0) {
      logger.stderr(maskSecrets === undefined ? line : maskSecrets(line));
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

/** Startup diagnostics for one server: exit status and the stderr tail. */
export interface TransportDiagnostics {
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  readonly stderr: string[];
}

export interface DownstreamTransport {
  transport: Transport;
  diagnostics: TransportDiagnostics;
}

const STDERR_TAIL_LIMIT = 5;

function pushStderrLine(tail: string[], line: string): void {
  tail.push(line);
  if (tail.length > STDERR_TAIL_LIMIT) {
    tail.shift();
  }
}

/**
 * A StdioClientTransport that remembers why its process died. The SDK does
 * not expose the child process, so this reads its private handle defensively;
 * when that is unavailable the doctor still shows stderr and a generic reason.
 */
class DiagnosticStdioTransport extends StdioClientTransport {
  readonly diagnostics: TransportDiagnostics = { exitCode: null, exitSignal: null, stderr: [] };

  constructor(params: StdioServerParameters) {
    super(params);
    const stderr = this.stderr;
    if (stderr !== null) {
      let buffer = '';
      stderr.on('data', (chunk: Buffer | string) => {
        buffer += chunk.toString();
        let index = buffer.indexOf('\n');
        while (index !== -1) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (line.length > 0) {
            pushStderrLine(this.diagnostics.stderr, line);
          }
          index = buffer.indexOf('\n');
        }
      });
      stderr.on('end', () => {
        if (buffer.length > 0) {
          pushStderrLine(this.diagnostics.stderr, buffer);
        }
        buffer = '';
      });
    }
  }

  override async start(): Promise<void> {
    await super.start();
    const child = (this as unknown as { _process?: ChildProcess })._process;
    if (child !== undefined) {
      child.once('exit', (code, signal) => {
        this.diagnostics.exitCode = code;
        this.diagnostics.exitSignal = signal;
      });
    }
  }
}

/** Builds the transport for one configured server (stdio or Streamable HTTP). */
export function createDownstreamTransport(
  name: string,
  config: ServerConfig,
  logger: Logger,
  maskSecrets?: (text: string) => string,
): DownstreamTransport {
  if (config.kind === 'stdio') {
    const transport = new DiagnosticStdioTransport({
      command: config.command,
      args: [...config.args],
      env: { ...parentEnvironment(), ...config.env },
      ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
      stderr: 'pipe',
    });
    const stderr = transport.stderr;
    if (stderr !== null) {
      forwardStderr(stderr as Readable, logger.child(name), maskSecrets);
    }
    return { transport, diagnostics: transport.diagnostics };
  }
  return {
    transport: new StreamableHTTPClientTransport(new URL(config.url)),
    diagnostics: { exitCode: null, exitSignal: null, stderr: [] },
  };
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function nestedErrorCode(error: unknown): string | undefined {
  return error instanceof Error ? errorCodeOf(error.cause) : undefined;
}

function serverTarget(config: ServerConfig): { target: string; targetKind: 'command' | 'url' } {
  return config.kind === 'stdio'
    ? { target: [config.command, ...config.args].join(' '), targetKind: 'command' }
    : { target: config.url, targetKind: 'url' };
}

/** The real reason a server failed to start, in plain words. */
function startupReason(
  config: ServerConfig,
  cause: unknown,
  diagnostics: TransportDiagnostics,
  timeoutMs: number,
): string {
  const code = errorCodeOf(cause);
  const nested = nestedErrorCode(cause);
  const message = describeError(cause);
  if (code === 'ENOENT' || message.includes('ENOENT')) {
    const command = config.kind === 'stdio' ? config.command : config.url;
    return `command not found: ${command}`;
  }
  if (config.kind === 'stdio' && diagnostics.exitCode !== null) {
    return `process exited with code ${diagnostics.exitCode}`;
  }
  if (config.kind === 'stdio' && diagnostics.exitSignal !== null) {
    return `process exited after signal ${diagnostics.exitSignal}`;
  }
  if (code === 'CONNECTION_CLOSED' || /connection closed/i.test(message)) {
    return 'the server exited before the MCP handshake finished';
  }
  if (nested === 'ECONNREFUSED' || code === 'ECONNREFUSED' || message.includes('ECONNREFUSED')) {
    return 'connection refused';
  }
  if (code === 'REQUEST_TIMEOUT' || /timed out|timeout/i.test(message)) {
    return `timed out after ${Math.round(timeoutMs / 1000)} s`;
  }
  return code === undefined ? message : `${message} (${code})`;
}

/** C20 rule 7: masks resolved config secrets in a failure's printed fields. */
function maskFailure(
  failure: DownstreamFailure,
  maskSecrets?: (text: string) => string,
): DownstreamFailure {
  if (maskSecrets === undefined) {
    return failure;
  }
  return {
    ...failure,
    why: maskSecrets(failure.why),
    target: maskSecrets(failure.target),
    stderr: failure.stderr.map((line) => maskSecrets(line)),
  };
}

/** Builds the doctor-facing startup failure for one server. */
export function startupFailure(
  name: string,
  config: ServerConfig,
  cause: unknown,
  diagnostics: TransportDiagnostics,
  timeoutMs: number,
): DownstreamFailure {
  const { target, targetKind } = serverTarget(config);
  return {
    name,
    what: `The downstream MCP server "${name}" failed to start.`,
    why: startupReason(config, cause, diagnostics, timeoutMs),
    fix:
      config.kind === 'stdio'
        ? 'Check the command and arguments, or remove this server from the config.'
        : 'Check the URL, or remove this server from the config.',
    target,
    targetKind,
    stderr: [...diagnostics.stderr],
  };
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
  private connectedOnce = false;
  private diagnostics: TransportDiagnostics = { exitCode: null, exitSignal: null, stderr: [] };

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
    try {
      await connection.connect();
    } catch (error) {
      // A startup failure is reported, not restarted (C13). Close the
      // half-built connection so no backoff timer lingers behind it.
      const failure = startupFailure(
        name,
        config,
        error,
        connection.diagnostics,
        options.connectTimeoutMs ?? 15_000,
      );
      await connection.close();
      throw new DownstreamStartupError(failure);
    }
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
        .warn(
          `closing the connection failed: ${describeErrorForLevel(this.options.logger, cause)}`,
        );
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
    const { transport, diagnostics } = createDownstreamTransport(
      this.name,
      this.config,
      this.options.logger,
      this.options.maskSecrets,
    );
    this.diagnostics = diagnostics;
    await client.connect(transport, { timeout: this.options.connectTimeoutMs ?? 15_000 });
    await this.reloadSurfaces();
    this.status = 'connected';
    this.failure = null;
    this.restarting = false;
    this.connectedOnce = true;
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
    // Before the first successful connect, a close is a startup failure that
    // the caller reports; there is nothing to restart yet.
    if (this.closed || this.restarting || !this.connectedOnce) {
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
      child.warn(`restart attempt failed: ${describeErrorForLevel(child, cause)}`);
      return false;
    }
  }

  private failureFor(cause: unknown): DownstreamFailure {
    return maskFailure(
      {
        name: this.name,
        what: `The downstream MCP server "${this.name}" is unavailable.`,
        why: describeError(cause),
        fix: 'Check the command or URL in the config.',
        ...serverTarget(this.config),
        stderr: [...this.diagnostics.stderr],
      },
      this.options.maskSecrets,
    );
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
    const failure = maskFailure(
      cause instanceof DownstreamStartupError
        ? cause.failure
        : startupFailure(
            name,
            config,
            cause,
            { exitCode: null, exitSignal: null, stderr: [] },
            options.connectTimeoutMs ?? 15_000,
          ),
      options.maskSecrets,
    );
    if (options.logger.level === 'debug') {
      options.logger.error(`${failure.what} Why: ${failure.why} Fix: ${failure.fix}`);
    } else {
      options.logger.error(`${failure.what} Fix: ${failure.fix}`);
    }
    return { ok: false, failure };
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
