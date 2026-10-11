import type { Readable } from 'node:stream';
import type { Implementation, Tool, Transport } from '@modelcontextprotocol/client';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { DownstreamUnavailableError } from 'twiceshy';
import type { ServerConfig } from './config.js';
import type { Logger } from './logger.js';

/**
 * Downstream connections (C13). One broken server never stops the others:
 * each connection is attempted independently and a failure is recorded with
 * what/why/fix for `twiceshy_status` and the doctor command.
 */

export interface DownstreamConnection {
  name: string;
  client: Client;
  tools: Tool[];
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

/**
 * Connects to one downstream server. Returns a typed failure instead of
 * throwing so the caller can keep starting the others (C13).
 */
export async function connectDownstream(
  name: string,
  config: ServerConfig,
  options: ConnectDownstreamOptions,
): Promise<
  { ok: true; connection: DownstreamConnection } | { ok: false; failure: DownstreamFailure }
> {
  const logger = options.logger.child(name);
  const client = new Client(options.clientInfo ?? DEFAULT_CLIENT_INFO, { capabilities: {} });
  try {
    const transport = createDownstreamTransport(name, config, options.logger);
    await client.connect(transport, { timeout: options.connectTimeoutMs ?? 15_000 });
    const tools = await listAllTools(client, options.listingTimeoutMs ?? 15_000);
    logger.info(`connected with ${tools.length} tool${tools.length === 1 ? '' : 's'}`);
    return { ok: true, connection: { name, client, tools } };
  } catch (cause) {
    const error = new DownstreamUnavailableError({ server: name, cause });
    logger.error(`${error.what} Why: ${error.why} Fix: ${error.fix}`);
    try {
      await client.close();
    } catch {
      // Best effort: the connection never completed, so there is nothing to save.
    }
    return {
      ok: false,
      failure: { name, what: error.what, why: error.why, fix: error.fix },
    };
  }
}

/** Connects to every configured server, in parallel, isolating failures (C13). */
export async function connectAllDownstreams(
  servers: Readonly<Record<string, ServerConfig>>,
  options: ConnectDownstreamOptions,
): Promise<Downstreams> {
  const results = await Promise.all(
    Object.entries(servers).map(([name, config]) => connectDownstream(name, config, options)),
  );
  const connections: DownstreamConnection[] = [];
  const failures: DownstreamFailure[] = [];
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
      await Promise.all(
        connections.map(async (connection) => {
          try {
            await connection.client.close();
          } catch (cause) {
            options.logger
              .child(connection.name)
              .warn(
                `closing the connection failed: ${cause instanceof Error ? cause.message : String(cause)}`,
              );
          }
        }),
      );
    },
  };
}
