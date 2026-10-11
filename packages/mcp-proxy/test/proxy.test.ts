import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { ConfigInvalidError } from 'twiceshy';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProxyHandle } from '../src/index.js';
import { createLogger, createProxy, loadConfig, startProxy } from '../src/index.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-server.mjs', import.meta.url));

const proxies = new Set<ProxyHandle>();
const clients = new Set<Client>();

class MemoryStream extends Writable {
  text = '';
  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.text += chunk.toString();
    callback();
  }
}

afterEach(async () => {
  await Promise.all([...clients].map((client) => client.close().catch(() => undefined)));
  clients.clear();
  await Promise.all([...proxies].map((proxy) => proxy.close().catch(() => undefined)));
  proxies.clear();
});

function stdioServer(mode: string): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  return { command: process.execPath, args: [FIXTURE, mode], env: {} };
}

function quietLogger(stream = new MemoryStream()): ReturnType<typeof createLogger> {
  return createLogger({ level: 'error', stream });
}

async function connectInMemoryClient(proxy: ProxyHandle): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await proxy.server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);
  clients.add(client);
  return client;
}

async function startTestProxy(
  servers: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<ProxyHandle> {
  const config = loadConfig({
    store: { type: 'memory' },
    mcpServers: servers,
    ...extra,
  });
  const proxy = await createProxy({ config, logger: quietLogger() });
  proxies.add(proxy);
  return proxy;
}

async function waitUntil(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error('condition was never met');
}

describe('proxy', () => {
  it('P1: merges two fake servers, prefixes names, preserves annotations and _meta, and follows pagination', async () => {
    const proxy = await startTestProxy({
      paginated: stdioServer('paginated'),
      simple: stdioServer('simple'),
    });
    expect(proxy.failures).toEqual([]);

    const client = await connectInMemoryClient(proxy);
    const listed = await client.listTools();
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));

    expect([...byName.keys()].sort()).toEqual([
      'paginated__alpha',
      'paginated__beta',
      'paginated__gamma',
      'simple__alpha',
      'simple__echo',
      'twiceshy_status',
    ]);

    // Pagination: gamma only exists on a second page of the fake server.
    expect(byName.get('paginated__gamma')?.description).toBe('No annotations at all');

    // Annotations are preserved exactly, including their absence.
    expect(byName.get('paginated__alpha')?.annotations).toEqual({
      readOnlyHint: true,
      idempotentHint: true,
    });
    expect(byName.get('paginated__beta')?.annotations).toEqual({ destructiveHint: true });
    expect(byName.get('paginated__gamma')?.annotations).toBeUndefined();
    expect(byName.get('simple__alpha')?.annotations).toEqual({
      readOnlyHint: true,
      idempotentHint: true,
    });

    // Tool _meta survives untouched.
    expect(byName.get('paginated__beta')?._meta).toEqual({ 'example/kept': 'yes' });

    // Calls route back to the right server and tool.
    const result = await client.callTool({
      name: 'paginated__alpha',
      arguments: { amount: 5 },
    });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'paginated:alpha:{"amount":5}' }]);

    const unknown = await client.callTool({ name: 'paginated__nope' });
    expect(unknown.isError).toBe(true);
  });

  it('re-reads a changed tool list and re-sends one merged list_changed notification', async () => {
    const proxy = await startTestProxy({ dyn: stdioServer('dynamic') });
    const client = await connectInMemoryClient(proxy);
    let changes = 0;
    client.setNotificationHandler('notifications/tools/list_changed', () => {
      changes += 1;
    });

    const before = await client.listTools();
    expect(before.tools.map((tool) => tool.name).sort()).toEqual([
      'dyn__alpha',
      'dyn__grow',
      'twiceshy_status',
    ]);

    await client.callTool({ name: 'dyn__grow', arguments: {} });
    await waitUntil(() => changes > 0);

    const after = await client.listTools();
    expect(after.tools.map((tool) => tool.name).sort()).toEqual([
      'dyn__alpha',
      'dyn__beta',
      'dyn__grow',
      'twiceshy_status',
    ]);
  });

  it('startProxy connects the MCP server to the given transport', async () => {
    const config = loadConfig({
      store: { type: 'memory' },
      mcpServers: { simple: stdioServer('simple') },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const proxy = await startProxy({ config }, serverTransport);
    proxies.add(proxy);

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);
    clients.add(client);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      'simple__alpha',
      'simple__echo',
      'twiceshy_status',
    ]);
  });

  it('P5: a server that fails at startup does not stop the proxy', async () => {
    const stream = new MemoryStream();
    const config = loadConfig({
      store: { type: 'memory' },
      mcpServers: {
        good: stdioServer('simple'),
        broken: stdioServer('broken'),
      },
    });
    const proxy = await createProxy({
      config,
      logger: createLogger({ level: 'debug', stream }),
    });
    proxies.add(proxy);

    expect(proxy.connections.map((connection) => connection.name)).toEqual(['good']);
    expect(proxy.failures).toHaveLength(1);
    const failure = proxy.failures[0];
    expect(failure?.name).toBe('broken');
    expect(failure?.what).toContain('broken');
    expect(failure?.why.length).toBeGreaterThan(0);
    expect(failure?.fix.length).toBeGreaterThan(0);

    // The child's stderr was forwarded with the server-name prefix.
    expect(stream.text).toContain('broken');
    expect(stream.text).toContain('fake server failed to start');

    const client = await connectInMemoryClient(proxy);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      'good__alpha',
      'good__echo',
      'twiceshy_status',
    ]);
  });

  it('P10: a tool name collision in none mode is CONFIG_INVALID naming both servers', async () => {
    const config = loadConfig({
      store: { type: 'memory' },
      toolNaming: 'none',
      mcpServers: {
        first: stdioServer('simple'),
        second: stdioServer('collide'),
      },
    });
    let caught: unknown;
    try {
      const proxy = await createProxy({ config, logger: quietLogger() });
      proxies.add(proxy);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigInvalidError);
    const error = caught as ConfigInvalidError;
    expect(error.why).toContain('alpha');
    expect(error.why).toContain('first');
    expect(error.why).toContain('second');
  });
});
