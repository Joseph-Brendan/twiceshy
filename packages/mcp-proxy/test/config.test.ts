import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigInvalidError } from 'twiceshy';
import { afterEach, describe, expect, it } from 'vitest';
import type { StdioServerConfig } from '../src/index.js';
import { loadConfig, loadConfigFile } from '../src/index.js';

const tempDirs = new Set<string>();

function tempFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'twiceshy-config-'));
  tempDirs.add(dir);
  const file = join(dir, 'twiceshy.config.json');
  writeFileSync(file, contents);
  return file;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

function capture(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('config', () => {
  it('P10: reports a missing env var, an unknown field, and a bad window in one CONFIG_INVALID error', () => {
    const raw = {
      store: { type: 'sqlite', path: '~/actions.db' },
      window: '10 minutes',
      unknownTopLevel: true,
      mcpServers: {
        paystack: {
          command: 'npx',
          args: ['-y', 'paystack-mcp'],
          // biome-ignore lint/suspicious/noTemplateCurlyInString: testing the ${VAR} placeholder syntax
          env: { PAYSTACK_SECRET_KEY: '${PAYSTACK_SECRET_KEY}' },
          keyfield: ['transaction'],
        },
      },
    };
    const caught = capture(() => loadConfig(raw, { env: {}, home: '/home/test' }));
    expect(caught).toBeInstanceOf(ConfigInvalidError);
    const error = caught as ConfigInvalidError;
    expect(error.code).toBe('CONFIG_INVALID');
    for (const fragment of [
      'window',
      'unknownTopLevel',
      'keyfield',
      'PAYSTACK_SECRET_KEY',
      'paystack',
    ]) {
      expect(error.why).toContain(fragment);
    }
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: ${VAR} names the syntax under test
  it('expands ${VAR} from the environment', () => {
    const config = loadConfig(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing the ${VAR} placeholder syntax
      { mcpServers: { server: { command: 'x', env: { TOKEN: '${TOKEN}', OTHER: 'plain' } } } },
      { env: { TOKEN: 'secret-value' }, home: '/home/test' },
    );
    const server = config.mcpServers.server as StdioServerConfig;
    expect(server.env.TOKEN).toBe('secret-value');
    expect(server.env.OTHER).toBe('plain');
  });

  it('expands a leading tilde using the provided home directory', () => {
    const config = loadConfig(
      { store: { type: 'sqlite', path: '~/.twiceshy/actions.db' }, mcpServers: {} },
      { home: '/home/test' },
    );
    expect(config.store).toEqual({
      type: 'sqlite',
      path: '/home/test/.twiceshy/actions.db',
    });
  });

  it('applies the spec defaults', () => {
    const config = loadConfig({ mcpServers: {} }, { home: '/home/test' });
    expect(config.store).toEqual({ type: 'sqlite', path: '/home/test/.twiceshy/actions.db' });
    expect(config.windowMs).toBe(600_000);
    expect(config.retentionMs).toBe(7 * 86_400_000);
    expect(config.onStoreFailure).toBe('closed');
    expect(config.toolNaming).toBe('prefix');
    expect(config.trustIdempotentHint).toBe(true);
    expect(config.annotateDuplicates).toBe(true);
    expect(config.exposeRecentActions).toBe(false);
  });

  it('parses per-tool options, including durations and normalisers', () => {
    const config = loadConfig({
      mcpServers: {
        server: {
          command: 'x',
          tools: {
            create_refund: {
              guard: true,
              keyFields: ['transaction', 'amount'],
              ignoreFields: ['reason'],
              normalize: { amount: 'number' },
              timeoutMs: '30s',
              treatToolErrorsAsDefinite: true,
            },
          },
        },
      },
    });
    const server = config.mcpServers.server as StdioServerConfig;
    expect(server.tools.create_refund).toEqual({
      guard: true,
      keyFields: ['transaction', 'amount'],
      ignoreFields: ['reason'],
      normalize: { amount: 'number' },
      timeoutMs: 30_000,
      treatToolErrorsAsDefinite: true,
    });
  });

  it('accepts a Streamable HTTP server configured by url', () => {
    const config = loadConfig({
      mcpServers: { remote: { url: 'https://example.com/mcp' } },
    });
    expect(config.mcpServers.remote).toEqual({
      kind: 'http',
      url: 'https://example.com/mcp',
      tools: {},
    });
  });

  it('rejects a typo inside a tool config with the unknown field name', () => {
    const caught = capture(() =>
      loadConfig({ mcpServers: { server: { command: 'x', tools: { t: { keyfields: [] } } } } }),
    );
    expect(caught).toBeInstanceOf(ConfigInvalidError);
    expect((caught as ConfigInvalidError).why).toContain('keyfields');
  });

  it('rejects a server with both command and url, and one with neither', () => {
    const caught = capture(() =>
      loadConfig({
        mcpServers: {
          both: { command: 'x', url: 'https://example.com/mcp' },
          neither: { args: ['x'] },
        },
      }),
    );
    expect(caught).toBeInstanceOf(ConfigInvalidError);
    const why = (caught as ConfigInvalidError).why;
    expect(why).toContain('mcpServers.both');
    expect(why).toContain('not both');
    expect(why).toContain('mcpServers.neither');
  });

  it('rejects an unknown store type and a memory store with extra fields', () => {
    const caught = capture(() =>
      loadConfig({ store: { type: 'postgres', path: 'x' }, mcpServers: {} }),
    );
    expect(caught).toBeInstanceOf(ConfigInvalidError);
    expect((caught as ConfigInvalidError).why).toContain('store.type');
  });

  it('reads a config file and reports invalid JSON as CONFIG_INVALID', () => {
    const good = loadConfigFile(tempFile('{ "store": { "type": "memory" }, "mcpServers": {} }'));
    expect(good.store).toEqual({ type: 'memory' });

    const caught = capture(() => loadConfigFile(tempFile('{ not json')));
    expect(caught).toBeInstanceOf(ConfigInvalidError);
    expect((caught as ConfigInvalidError).why).toContain('not valid JSON');
  });

  it('reports an unreadable config file as CONFIG_INVALID', () => {
    const caught = capture(() => loadConfigFile(join(tmpdir(), 'twiceshy-does-not-exist.json')));
    expect(caught).toBeInstanceOf(ConfigInvalidError);
    expect((caught as ConfigInvalidError).why).toContain('could not read');
  });
});
