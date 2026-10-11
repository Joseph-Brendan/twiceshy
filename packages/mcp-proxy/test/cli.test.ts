import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import type { ProxyHandle } from '../src/index.js';

const tempDirs = new Set<string>();

function tempConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'twiceshy-cli-'));
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

describe('cli', () => {
  it('runs the proxy command and returns 0 after the client disconnects', async () => {
    const configPath = tempConfig(JSON.stringify({ store: { type: 'memory' }, mcpServers: {} }));
    let closed = 0;
    let started = false;
    const start = (async () => {
      started = true;
      return {
        close: async () => {
          closed += 1;
        },
      } as unknown as ProxyHandle;
    }) as never;

    const running = runCli(['proxy', '--config', configPath, '--log-level', 'debug'], {
      start,
    });
    while (!started) {
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    }
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    // The shutdown waiter is registered now; the client disconnects.
    process.stdin.emit('end');

    expect(await running).toBe(0);
    expect(closed).toBe(1);
  });

  it('returns 1 when the config file is invalid', async () => {
    const configPath = tempConfig('{ not json');
    expect(await runCli(['proxy', '--config', configPath])).toBe(1);
  });
});
