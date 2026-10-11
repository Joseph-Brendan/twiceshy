import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuard } from 'twiceshy';
import { SqliteStore } from 'twiceshy/sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { REPO_ROOT } from './helpers/built-binary.js';

const EXAMPLE_SERVER = fileURLToPath(new URL('./fixtures/example-server.mjs', import.meta.url));

const tempDirs = new Set<string>();

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'twiceshy-doctor-'));
  tempDirs.add(dir);
  return dir;
}

function writeConfig(config: unknown): string {
  const file = join(tempDir(), 'config.json');
  writeFileSync(file, JSON.stringify(config));
  return file;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

interface Capture {
  io: { out(text: string): void; err(text: string): void };
  text(): string;
}

function capture(): Capture {
  let out = '';
  return {
    io: {
      out: (text) => {
        out += text;
      },
      err: () => undefined,
    },
    text: () => out,
  };
}

interface FailureReport {
  name: string;
  why: string;
  target: string;
  targetKind: 'command' | 'url';
  stderr: string[];
}

async function doctorJson(
  config: string,
): Promise<{ report: Record<string, unknown>; text: string; code: number }> {
  const captured = capture();
  const code = await runCli(['doctor', '--json', '--config', config], {
    io: captured.io,
    cwd: REPO_ROOT,
  });
  return {
    report: JSON.parse(captured.text()) as Record<string, unknown>,
    text: captured.text(),
    code,
  };
}

function failuresOf(report: Record<string, unknown>): FailureReport[] {
  return (report.servers as FailureReport[]).filter((server) => 'why' in server);
}

async function unusedLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 9;
      server.close(() => resolve(port));
    });
  });
}

describe('doctor startup failures', () => {
  it('shows "command not found" for a missing command', async () => {
    const config = writeConfig({
      store: { type: 'memory' },
      mcpServers: { missing: { command: 'definitely-not-a-command-xyz' } },
    });
    const { report, code } = await doctorJson(config);
    expect(code).toBe(1);
    const [failure] = failuresOf(report);
    expect(failure?.why).toBe('command not found: definitely-not-a-command-xyz');
    expect(failure?.target).toBe('definitely-not-a-command-xyz');
    expect(failure?.targetKind).toBe('command');
  });

  it('shows the process exit code for a server that exits immediately', async () => {
    const config = writeConfig({
      store: { type: 'memory' },
      mcpServers: {
        exits: {
          command: process.execPath,
          args: ['-e', "process.stderr.write('one\\ntwo\\n'); process.exit(3);"],
        },
      },
    });
    const { report, code } = await doctorJson(config);
    expect(code).toBe(1);
    const [failure] = failuresOf(report);
    expect(failure?.why).toBe('process exited with code 3');
    expect(failure?.stderr).toEqual(['one', 'two']);
  });

  it('shows "connection refused" for an unreachable URL', async () => {
    // Loopback only: this intentionally talks to a closed local port.
    const port = await unusedLoopbackPort();
    const config = writeConfig({
      store: { type: 'memory' },
      mcpServers: { remote: { url: `http://127.0.0.1:${port}/mcp` } },
    });
    const { report, code } = await doctorJson(config);
    expect(code).toBe(1);
    const [failure] = failuresOf(report);
    expect(failure?.why).toBe('connection refused');
    expect(failure?.target).toBe(`http://127.0.0.1:${port}/mcp`);
    expect(failure?.targetKind).toBe('url');
  });

  it('keeps the last five stderr lines of a failing stdio server and shows them (text and JSON)', async () => {
    const script =
      "[1,2,3,4,5,6,7].forEach((n) => process.stderr.write('line ' + n + '\\n')); process.exit(2);";
    const config = writeConfig({
      store: { type: 'memory' },
      mcpServers: { chatty: { command: process.execPath, args: ['-e', script] } },
    });
    const { report } = await doctorJson(config);
    const [failure] = failuresOf(report);
    expect(failure?.stderr).toEqual(['line 3', 'line 4', 'line 5', 'line 6', 'line 7']);

    const captured = capture();
    await runCli(['doctor', '--config', config], { io: captured.io, cwd: REPO_ROOT });
    expect(captured.text()).toContain('line 3');
    expect(captured.text()).toContain('line 7');
    expect(captured.text()).not.toContain('line 2');
  });
});

describe('doctor logging', () => {
  it('prints no JSON log lines by default, including with --json, but does with --log-level info', async () => {
    const config = writeConfig({
      store: { type: 'memory' },
      mcpServers: { broken: { command: process.execPath, args: ['-e', 'process.exit(1)'] } },
    });

    for (const argv of [
      ['doctor', '--config', config],
      ['doctor', '--json', '--config', config],
    ]) {
      const writes: string[] = [];
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });
      const captured = capture();
      await runCli(argv, { io: captured.io, cwd: REPO_ROOT });
      spy.mockRestore();
      expect(writes.join(''), argv.join(' ')).not.toContain('"level"');
    }

    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const captured = capture();
    await runCli(['doctor', '--log-level', 'info', '--config', config], {
      io: captured.io,
      cwd: REPO_ROOT,
    });
    spy.mockRestore();
    expect(writes.join('')).toContain('"level"');
  });
});

describe('doctor store report', () => {
  it('shows zero records in doubt, and two with the review hint', async () => {
    const dbPath = join(tempDir(), 'actions.db');
    const config = writeConfig({
      store: { type: 'sqlite', path: dbPath },
      mcpServers: {},
    });

    const empty = capture();
    await runCli(['doctor', '--config', config], { io: empty.io, cwd: REPO_ROOT });
    expect(empty.text()).toContain('0 records in doubt');
    expect(empty.text()).not.toContain('twiceshy list --state IN_DOUBT');

    const store = new SqliteStore({ path: dbPath });
    const guard = createGuard({ store, namespace: 'seed' });
    for (const transaction of ['T1', 'T2']) {
      await guard
        .run({ tool: 'paystack.refund', args: { transaction } }, () => {
          throw new Error('socket hang up');
        })
        .catch(() => undefined);
    }
    await guard.close();

    const seeded = capture();
    await runCli(['doctor', '--config', config], { io: seeded.io, cwd: REPO_ROOT });
    expect(seeded.text()).toContain('2 records in doubt');
    expect(seeded.text()).toContain('twiceshy list --state IN_DOUBT');
  });

  it('shortens the store path under the injected home to ~', async () => {
    const home = tempDir();
    const config = writeConfig({
      store: { type: 'sqlite', path: '~/actions.db' },
      mcpServers: {},
    });
    const captured = capture();
    await runCli(['doctor', '--config', config], { io: captured.io, cwd: REPO_ROOT, home });
    expect(captured.text()).toContain('Store    sqlite  ~/actions.db');
    expect(captured.text()).toContain('0 records in doubt');
  });
});

describe('doctor lifecycle', () => {
  it('exits 0 when every server connects and shuts down every server it started', async () => {
    const pidFile = join(tempDir(), 'server.pid');
    const config = writeConfig({
      store: { type: 'memory' },
      mcpServers: {
        example: {
          command: 'node',
          args: [EXAMPLE_SERVER],
          env: { TWICESHY_EXAMPLE_PID_FILE: pidFile },
        },
      },
    });
    const captured = capture();
    const code = await runCli(['doctor', '--config', config], { io: captured.io, cwd: REPO_ROOT });
    expect(code).toBe(0);
    expect(captured.text()).toContain('1 of 1 server connected.');

    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    const deadline = Date.now() + 5_000;
    let gone = false;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        gone = true;
        break;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    }
    expect(gone).toBe(true);
  });

  it('exits 1 when any server fails', async () => {
    const config = writeConfig({
      store: { type: 'memory' },
      mcpServers: { broken: { command: process.execPath, args: ['-e', 'process.exit(1)'] } },
    });
    const captured = capture();
    expect(await runCli(['doctor', '--config', config], { io: captured.io, cwd: REPO_ROOT })).toBe(
      1,
    );
  });
});
