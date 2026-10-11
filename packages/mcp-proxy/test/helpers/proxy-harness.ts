import { Writable } from 'node:stream';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { Server } from '@modelcontextprotocol/server';
import type { DownstreamConnection, Downstreams, ProxyHandle } from '../../src/index.js';
import { createLogger, createProxy, listAllTools, loadConfig } from '../../src/index.js';

/** Connects a real SDK client to a fixture server over an in-memory transport. */
export async function connectInProcess(
  name: string,
  server: Server,
): Promise<DownstreamConnection> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: 'twiceshy-test-client', version: '1.0.0' },
    { capabilities: { sampling: {}, elicitation: {} } },
  );
  await client.connect(clientTransport);
  const tools = await listAllTools(client, 5_000);
  const capabilities = client.getServerCapabilities();
  const safeList = async <T>(load: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await load();
    } catch {
      return [];
    }
  };
  const resources =
    capabilities?.resources === undefined
      ? []
      : await safeList(async () => (await client.listResources()).resources);
  const resourceTemplates =
    capabilities?.resources === undefined
      ? []
      : await safeList(async () => (await client.listResourceTemplates()).resourceTemplates);
  const prompts =
    capabilities?.prompts === undefined
      ? []
      : await safeList(async () => (await client.listPrompts()).prompts);
  return {
    name,
    client,
    tools,
    resources,
    resourceTemplates,
    prompts,
    status: 'connected',
    failure: null,
    callTool: (params, options) => client.callTool(params, options),
    close: async () => {
      await client.close();
    },
  };
}

export function inProcessDownstreams(connections: DownstreamConnection[]): Downstreams {
  return {
    connections,
    failures: [],
    close: async () => {
      await Promise.all(connections.map((connection) => connection.client.close()));
    },
  };
}

/** Connects a test client to the proxy's own MCP server. */
export async function connectToProxy(proxy: ProxyHandle): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await proxy.server.connect(serverTransport);
  const client = new Client({ name: 'twiceshy-test-client', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

/**
 * Builds a proxy over an in-process fixture server. The config carries a
 * placeholder command because the injected downstream replaces it; per-tool
 * options and global options still come from the real config schema.
 */
export async function startInProcessProxy(options: {
  name: string;
  server: Server;
  tools?: Record<string, unknown>;
  extraConfig?: Record<string, unknown>;
}): Promise<{ proxy: ProxyHandle; client: Client; connection: DownstreamConnection }> {
  const connection = await connectInProcess(options.name, options.server);
  const config = loadConfig({
    store: { type: 'memory' },
    mcpServers: {
      [options.name]: { command: 'in-process', tools: options.tools ?? {} },
    },
    ...options.extraConfig,
  });
  const proxy = await createProxy({
    config,
    downstreams: inProcessDownstreams([connection]),
    logger: silentLogger(),
  });
  const client = await connectToProxy(proxy);
  return { proxy, client, connection };
}

/** Real-time polling with a deadline; the only thing tests wait on. */
export async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error('condition was never met');
}

export function textOf(block: unknown): string {
  return typeof block === 'object' && block !== null && 'text' in block
    ? String((block as { text: unknown }).text)
    : '';
}

export function silentLogger(): ReturnType<typeof createLogger> {
  return createLogger({
    level: 'error',
    stream: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });
}
