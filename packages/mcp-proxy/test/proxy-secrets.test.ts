import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { Client } from '@modelcontextprotocol/client';
import { Server } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import type { LogLevel, ProxyHandle } from '../src/index.js';
import {
  createLogger,
  createProxy,
  createSecretMasker,
  loadConfig,
  MIN_SECRET_LENGTH,
  maskSecretValues,
} from '../src/index.js';
import { REPO_ROOT } from './helpers/built-binary.js';
import {
  connectInProcess,
  connectToProxy,
  inProcessDownstreams,
  startInProcessProxy,
  textOf,
  waitUntil,
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

describe('C20 rule 19: resolvedEnvValues never appears in output, logs, status, or errors', () => {
  const RELEASE_SECRET = 'sk_live_RELEASECHECK';
  const LEAKY_FIXTURE = fileURLToPath(new URL('./fixtures/leaky-server.mjs', import.meta.url));

  function leakyConfig(): ReturnType<typeof loadConfig> {
    return loadConfig(
      {
        store: { type: 'memory' },
        mcpServers: {
          leaky: {
            command: process.execPath,
            args: [LEAKY_FIXTURE],
            // biome-ignore lint/suspicious/noTemplateCurlyInString: ${VAR} is the documented placeholder syntax
            env: { TWICESHY_TEST_SECRET: '${TWICESHY_TEST_SECRET}' },
          },
        },
      },
      { env: { TWICESHY_TEST_SECRET: RELEASE_SECRET } },
    );
  }

  it('never appears in a log line at error, warn, info, or debug level', async () => {
    for (const level of ['error', 'warn', 'info', 'debug'] as const) {
      const { lines, stream } = captureLines();
      const proxy = await createProxy({
        config: leakyConfig(),
        logger: createLogger({ level, stream }),
      });
      proxies.add(proxy);
      const client = await connectToProxy(proxy);
      clients.add(client);

      await waitUntil(() => lines.join('').includes('leaky server booted'));
      const result = await client.callTool({ name: 'leaky__explode', arguments: {} });
      expect(result.isError).toBe(true);
      const status = await client.callTool({ name: 'twiceshy_status', arguments: {} });
      expect(textOf(status.content[0])).toContain('leaky');

      const logged = lines.join('');
      expect(logged, level).not.toContain(RELEASE_SECRET);
      expect(logged, level).toContain('[redacted]');
    }
  });

  it('never appears in a blocked tool result or a stored record', async () => {
    const { lines, stream } = captureLines();
    const proxy = await createProxy({
      config: leakyConfig(),
      logger: createLogger({ level: 'warn', stream }),
    });
    proxies.add(proxy);
    const client = await connectToProxy(proxy);
    clients.add(client);

    const result = await client.callTool({ name: 'leaky__explode', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result.content[0])).not.toContain(RELEASE_SECRET);
    expect(textOf(result.content[0]).toLowerCase()).toContain('unavailable');

    const [record] = await proxy.store.list({ toolName: 'explode' });
    expect(record?.errorSummary ?? '').not.toContain(RELEASE_SECRET);
    expect(lines.join('')).not.toContain(RELEASE_SECRET);
  });

  it('never appears in doctor text or doctor --json output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'twiceshy-release-'));
    try {
      const configFile = join(dir, 'config.json');
      writeFileSync(
        configFile,
        JSON.stringify({
          store: { type: 'memory' },
          mcpServers: {
            leaky: {
              command: process.execPath,
              args: [LEAKY_FIXTURE],
              // biome-ignore lint/suspicious/noTemplateCurlyInString: ${VAR} is the documented placeholder syntax
              env: { TWICESHY_TEST_SECRET: '${TWICESHY_TEST_SECRET}' },
            },
          },
        }),
      );
      process.env.TWICESHY_TEST_SECRET = RELEASE_SECRET;
      for (const argv of [
        ['doctor', '--config', configFile],
        ['doctor', '--json', '--config', configFile],
      ]) {
        let out = '';
        let err = '';
        const code = await runCli(argv, {
          io: {
            out: (text) => {
              out += text;
            },
            err: (text) => {
              err += text;
            },
          },
          cwd: REPO_ROOT,
        });
        expect(code, argv.join(' ')).toBe(0);
        expect(out, argv.join(' ')).not.toContain(RELEASE_SECRET);
        expect(err, argv.join(' ')).not.toContain(RELEASE_SECRET);
        if (argv.includes('--json')) {
          expect(out, argv.join(' ')).toContain('"surface": "resources"');
        } else {
          expect(out, argv.join(' ')).toContain('could not list resources');
        }
      }
    } finally {
      delete process.env.TWICESHY_TEST_SECRET;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
