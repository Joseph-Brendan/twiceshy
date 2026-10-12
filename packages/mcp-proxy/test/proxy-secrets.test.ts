import { Writable } from 'node:stream';
import type { Client } from '@modelcontextprotocol/client';
import { Server } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { LogLevel, ProxyHandle } from '../src/index.js';
import {
  createLogger,
  createProxy,
  createSecretMasker,
  loadConfig,
  MIN_SECRET_LENGTH,
  maskSecretValues,
} from '../src/index.js';
import {
  connectInProcess,
  connectToProxy,
  inProcessDownstreams,
  startInProcessProxy,
  textOf,
} from './helpers/proxy-harness.js';

/**
 * C20 rules 5 and 6: secrets must not reach logs or stored results.
 */

const SECRET = 'sk_live_TESTSECRET';

const proxies = new Set<ProxyHandle>();
const clients = new Set<Client>();

afterEach(async () => {
  await Promise.all([...clients].map((client) => client.close().catch(() => undefined)));
  clients.clear();
  await Promise.all([...proxies].map((proxy) => proxy.close().catch(() => undefined)));
  proxies.clear();
});

function captureLines(): { lines: string[]; stream: Writable } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { lines, stream };
}

function secretServer(): Server {
  const server = new Server({ name: 'secret', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler('tools/list', async () => ({
    tools: [
      {
        name: 'explode',
        description: 'Always fails with a downstream message',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }));
  server.setRequestHandler('tools/call', async () => {
    throw new Error(`the provider rejected the request with key ${SECRET}`);
  });
  return server;
}

async function callFailingTool(level: LogLevel): Promise<string> {
  const connection = await connectInProcess('secret', secretServer());
  const config = loadConfig({
    store: { type: 'memory' },
    mcpServers: { secret: { command: 'in-process' } },
  });
  const { lines, stream } = captureLines();
  const proxy = await createProxy({
    config,
    downstreams: inProcessDownstreams([connection]),
    logger: createLogger({ level, stream }),
  });
  proxies.add(proxy);
  const client = await connectToProxy(proxy);
  clients.add(client);

  const result = await client.callTool({ name: 'secret__explode', arguments: {} });
  expect(result.isError).toBe(true);
  return lines.join('');
}

describe('C20 rule 5: raw downstream error text stays out of warn and info logs', () => {
  it('a downstream error containing a secret never appears at warn or info level', async () => {
    for (const level of ['warn', 'info'] as const) {
      const logged = await callFailingTool(level);
      expect(logged, level).not.toContain(SECRET);
      expect(logged, level).toContain('in doubt');
    }
  });

  it('the full downstream message appears only at debug level', async () => {
    const logged = await callFailingTool('debug');
    expect(logged).toContain(SECRET);
  });
});

function tokenServer(): Server {
  const server = new Server({ name: 'tokens', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler('tools/list', async () => ({
    tools: [
      {
        name: 'issue',
        description: 'Returns a structured result with a token',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }));
  server.setRequestHandler('tools/call', async () => ({
    content: [{ type: 'text', text: 'issued' }],
    structuredContent: { token: SECRET, amount: 10 },
  }));
  return server;
}

describe('C20 rule 6: results are redacted before storage', () => {
  it('a duplicate returns the stored redacted result and says so in _meta', async () => {
    const started = await startInProcessProxy({ name: 'tokens', server: tokenServer() });
    proxies.add(started.proxy);
    clients.add(started.client);

    const first = await started.client.callTool({ name: 'tokens__issue', arguments: {} });
    expect(first.structuredContent).toEqual({ token: SECRET, amount: 10 });

    const retry = await started.client.callTool({ name: 'tokens__issue', arguments: {} });
    expect(retry.structuredContent).toEqual({ token: '[redacted]', amount: 10 });
    expect(retry._meta?.['dev.twiceshy/outcome']).toMatchObject({
      status: 'duplicate',
      resultRedacted: true,
    });
  });

  it('storeResult false keeps no result and a duplicate returns a short summary saying it already ran', async () => {
    const started = await startInProcessProxy({
      name: 'tokens',
      server: tokenServer(),
      tools: { issue: { storeResult: false } },
    });
    proxies.add(started.proxy);
    clients.add(started.client);

    const first = await started.client.callTool({ name: 'tokens__issue', arguments: {} });
    expect(first.structuredContent).toEqual({ token: SECRET, amount: 10 });
    const [record] = await started.proxy.store.list({});
    expect(record?.result).toBeUndefined();

    const retry = await started.client.callTool({ name: 'tokens__issue', arguments: {} });
    expect(textOf(retry.content[0])).toContain('already ran');
    expect(textOf(retry.content[0])).toContain('No result was stored');
    expect(retry.structuredContent).toBeUndefined();
    expect(retry._meta?.['dev.twiceshy/outcome']).toMatchObject({
      status: 'duplicate',
      resultRedacted: false,
    });
  });
});

describe('C20 rule 7: config records resolved values and the masker hides them', () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the documented ${VAR} placeholder
  it('loadConfig records every value resolved from ${VAR}', () => {
    const config = loadConfig(
      {
        store: { type: 'memory' },
        mcpServers: {
          // biome-ignore lint/suspicious/noTemplateCurlyInString: ${VAR} is the documented placeholder syntax
          srv: { command: 'node', env: { KEY: '${KEY}', OTHER: 'plain' } },
        },
      },
      { env: { KEY: 'sk_live_FROM_CONFIG' } },
    );
    expect(config.resolvedEnvValues).toEqual(['sk_live_FROM_CONFIG']);
  });

  it('masks every occurrence of a value of six or more characters, longest first', () => {
    expect(
      maskSecretValues('uses sk_live_TESTSECRET and sk_live_TEST', [
        'sk_live_TEST',
        'sk_live_TESTSECRET',
      ]),
    ).toBe('uses [redacted] and [redacted]');
    expect(maskSecretValues('pin 12345', ['12345'])).toBe('pin 12345');
    expect(MIN_SECRET_LENGTH).toBe(6);
  });

  it('createSecretMasker leaves text unchanged when there is nothing long enough to mask', () => {
    const mask = createSecretMasker(['short']);
    expect(mask('some short text')).toBe('some short text');
  });
});
