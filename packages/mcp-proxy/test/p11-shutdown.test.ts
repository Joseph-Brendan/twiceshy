import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI_PATH, ensureBuilt } from './helpers/built-binary.js';

const PROGRESS_FIXTURE = fileURLToPath(new URL('./fixtures/progress-server.mjs', import.meta.url));

const tempDirs = new Set<string>();
const children = new Set<ChildProcessWithoutNullStreams>();

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'twiceshy-p11-'));
  tempDirs.add(dir);
  return dir;
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

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error(`timed out waiting for ${file}`);
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the child did not exit in time')), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

describe('P11: graceful shutdown', () => {
  it('P11: SIGTERM during an in-flight call waits for it, then exits with code 0', {
    timeout: 60_000,
  }, async () => {
    ensureBuilt();

    const dir = tempDir();
    const startFile = join(dir, 'started.txt');
    const configFile = join(dir, 'twiceshy.config.json');
    writeFileSync(
      configFile,
      JSON.stringify({
        store: { type: 'memory' },
        mcpServers: {
          progress: {
            command: process.execPath,
            args: [PROGRESS_FIXTURE],
            env: {
              TWICESHY_SLOW_REPLY_MS: '700',
              TWICESHY_SLOW_START_FILE: startFile,
            },
            tools: { slow: { guard: false } },
          },
        },
      }),
    );

    const child = spawn(
      process.execPath,
      [CLI_PATH, 'proxy', '--log-level', 'debug', '--config', configFile],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NODE_ENV: 'production' },
      },
    );
    children.add(child);
    const stderrLines: string[] = [];
    let exitInfo = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrLines.push(chunk.toString());
    });
    child.on('exit', (code, signal) => {
      exitInfo = `proxy exited code=${String(code)} signal=${String(signal)}`;
    });

    const pending = new Map<number, (message: { result?: unknown }) => void>();
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim() !== '') {
          const message = JSON.parse(line) as { id?: unknown };
          if (typeof message.id === 'number' && pending.has(message.id)) {
            pending.get(message.id)?.(message as { result?: unknown });
            pending.delete(message.id);
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
          reject(
            new Error(
              `timed out waiting for ${method}${exitInfo === '' ? '' : ` (${exitInfo})`}; stderr: ${stderrLines.join('')}`,
            ),
          );
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

    await request('initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'p11-client', version: '1.0.0' },
    });
    notify('notifications/initialized', {});

    const inFlight = request('tools/call', { name: 'progress__slow', arguments: {} });
    await waitForFile(startFile, 10_000);

    // Windows has no POSIX signals: Node maps SIGTERM to TerminateProcess,
    // which cannot run the graceful handler. The closest equivalent proves
    // termination, while the graceful wait and exit code are proven on POSIX.
    child.kill('SIGTERM');
    if (process.platform === 'win32') {
      const exit = await waitForExit(child, 15_000);
      expect(exit.signal === 'SIGTERM' || exit.code !== null).toBe(true);
      return;
    }

    const response = await inFlight;
    expect((response.content as { text: string }[])[0]?.text).toBe('slow done');

    const exit = await waitForExit(child, 15_000);
    expect(exit.code).toBe(0);
  });
});
