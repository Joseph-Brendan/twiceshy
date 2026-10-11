import type { Implementation } from '@modelcontextprotocol/client';
import type { CallToolResult, Tool, Transport } from '@modelcontextprotocol/server';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { ProxyConfig } from './config.js';
import type { DownstreamConnection, DownstreamFailure } from './downstream.js';
import { connectAllDownstreams, listAllTools } from './downstream.js';
import { createLogger, type Logger } from './logger.js';
import { buildToolRouting, type ToolRouting } from './naming.js';
import { PROXY_VERSION } from './version.js';

/**
 * The proxy (C13, minimal for Phase 3.1): an MCP server to the agent and a
 * client to every downstream server. Tools are merged with annotations and
 * `_meta` preserved, and calls are forwarded unguarded until Phase 3.2.
 */

export interface ProxyOptions {
  config: ProxyConfig;
  logger?: Logger;
  clientInfo?: Implementation;
}

export interface ProxyHandle {
  readonly server: Server;
  readonly connections: readonly DownstreamConnection[];
  readonly failures: readonly DownstreamFailure[];
  /** The merged tool list exactly as `tools/list` reports it. */
  exposedTools(): Tool[];
  close(): Promise<void>;
}

interface ToolRoute {
  connection: DownstreamConnection;
  toolName: string;
}

function toolError(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export async function createProxy(options: ProxyOptions): Promise<ProxyHandle> {
  const logger = options.logger ?? createLogger();
  const downstreams = await connectAllDownstreams(options.config.mcpServers, {
    logger,
    ...(options.clientInfo === undefined ? {} : { clientInfo: options.clientInfo }),
  });

  let routing: ToolRouting;
  try {
    routing = buildToolRouting(downstreams.connections, options.config.toolNaming);
  } catch (cause) {
    await downstreams.close();
    throw cause;
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
      routes.set(entry.exposedName, { connection, toolName: entry.toolName });
      // Spread keeps description, inputSchema, annotations, and _meta exactly.
      exposed.push({ ...tool, name: entry.exposedName });
    }
    return exposed;
  };
  let exposed = collectExposedTools();

  const server = new Server(
    { name: 'twiceshy', version: PROXY_VERSION },
    { capabilities: { tools: { listChanged: true } } },
  );

  server.setRequestHandler('tools/list', async () => ({ tools: exposed }));

  server.setRequestHandler('tools/call', async (request) => {
    const route = routes.get(request.params.name);
    if (route === undefined) {
      return toolError(
        `Twiceshy: unknown tool "${request.params.name}". It is not provided by any configured server.`,
      );
    }
    try {
      return await route.connection.client.callTool({
        name: route.toolName,
        ...(request.params.arguments === undefined ? {} : { arguments: request.params.arguments }),
        ...(request.params._meta === undefined ? {} : { _meta: request.params._meta }),
      });
    } catch (cause) {
      return toolError(
        `Twiceshy: the downstream server "${route.connection.name}" failed while calling "${route.toolName}": ${describeError(cause)}`,
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
    exposedTools: () => exposed,
    close: async () => {
      await downstreams.close();
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
