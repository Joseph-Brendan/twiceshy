import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { execSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI_PATH = join(REPO_ROOT, 'packages/mcp-proxy/dist/cli.js');
const CORE_DIST = join(REPO_ROOT, 'packages/core/dist/index.js');
const COUNTER_FIXTURE = fileURLToPath(new URL('./fixtures/counter-server.mjs', import.meta.url));

const tempDirs = new Set<string>();
const children = new Set<ChildProcessWithoutNullStreams>();

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs);
  }
  return newest;
}

/** P9 tests the real binary, so make sure it reflects the current sources. */
function ensureBuilt(): void {
  const sourcesNewest = Math.max(
    newestMtime(join(REPO_ROOT, 'packages/mcp-proxy/src')),
    newestMtime(join(REPO_ROOT, 'packages/core/src')),
  );
  const builtNewest = Math.min(
    existsSync(CLI_PATH) ? statSync(CLI_PATH).mtimeMs : 0,
    existsSync(CORE_DIST) ? statSync(CORE_DIST).mtimeMs : 0,
  );
  if (existsSync(CLI_PATH) && existsSync(CORE_DIST) && builtNewest >= sourcesNewest) {
    return;
  }
  execSync('pnpm build', { cwd: REPO_ROOT, stdio: 'pipe' });
}

afterEach(() => {
  for (const child of children) {
    child.kill('SIGKILL');
  }
  children.clear();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('P9: stdout purity of the built proxy', () => {
  it('P9: the real proxy binary over stdio answers a full session with JSON-RPC only', async () => {
    ensureBuilt();

    const dir = mkdtempSync(join(tmpdir(), 'twiceshy-p9-'));
    tempDirs.add(dir);
    const counterFile = join(dir, 'counter.txt');
    const configFile = join(dir, 'twiceshy.config.json');
    writeFileSync(
      configFile,
      JSON.stringify({
        store: { type: 'memory' },
        mcpServers: {
          counter: {
            command: process.execPath,
            args: [COUNTER_FIXTURE],
            env: { TWICESHY_COUNTER_FILE: counterFile },
          },
        },
      }),
    );

    const child = spawn(process.execPath, [CLI_PATH, 'proxy', '--config', configFile], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'production' },
    });
    children.add(child);

    const stdoutLines: string[] = [];
    const pending = new Map<number, (message: { result?: unknown }) => void>();
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim() !== '') {
          stdoutLines.push(line);
          try {
            const message = JSON.parse(line) as { id?: unknown };
            if (typeof message.id === 'number' && pending.has(message.id)) {
              pending.get(message.id)?.(message as { result?: unknown });
              pending.delete(message.id);
            }
          } catch {
            // A non-JSON line is caught by the final assertion; keep reading.
          }
        }
        index = buffer.indexOf('\n');
      }
    });

    let nextId = 1;
    const request = (method: string, params: unknown): Promise<Record<string, unknown>> => {
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timed out waiting for ${method}`));
        }, 20_000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve((message.result ?? {}) as Record<string, unknown>);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    };
    const notify = (method: string, params: unknown): void => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    };

    const initialized = await request('initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'p9-client', version: '1.0.0' },
    });
    expect((initialized.serverInfo as { name?: string } | undefined)?.name).toBe('twiceshy');
    notify('notifications/initialized', {});

    const listed = await request('tools/list', {});
    const names = (listed.tools as { name: string }[]).map((tool) => tool.name);
    expect(names).toContain('counter__create_charge');
    expect(names).toContain('twiceshy_status');

    const first = await request('tools/call', {
      name: 'counter__create_charge',
      arguments: { amount: 1500 },
    });
    expect((first.content as { text: string }[])[0]?.text).toBe('charged 1');

    const second = await request('tools/call', {
      name: 'counter__create_charge',
      arguments: { amount: 1500 },
    });
    expect((second.content as { text: string }[])[0]?.text).toContain(
      'Twiceshy: this action already ran at',
    );
    expect(
      (second._meta as Record<string, { status?: string }> | undefined)?.['dev.twiceshy/outcome']
        ?.status,
    ).toBe('duplicate');

    const status = await request('tools/call', { name: 'twiceshy_status', arguments: {} });
    expect((status.content as { text: string }[])[0]?.text).toContain('counter: connected');

    expect(Number(readFileSync(counterFile, 'utf8').trim())).toBe(1);

    // Every line the child ever wrote to stdout must be valid JSON-RPC.
    expect(stdoutLines.length).toBeGreaterThanOrEqual(5);
    for (const line of stdoutLines) {
      const message = JSON.parse(line) as { jsonrpc?: unknown; id?: unknown; method?: unknown };
      expect(message.jsonrpc).toBe('2.0');
      expect(message.id !== undefined || message.method !== undefined).toBe(true);
    }
  });
});
