import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createGuard } from 'twiceshy';
import { SqliteStore } from 'twiceshy/sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { createLogger } from '../src/index.js';
import { REPO_ROOT } from './helpers/built-binary.js';

const EXAMPLE_SERVER = fileURLToPath(new URL('./fixtures/example-server.mjs', import.meta.url));
const EXAMPLE_CONFIG = fileURLToPath(new URL('./fixtures/example.config.json', import.meta.url));
const SNAPSHOT = fileURLToPath(new URL('./fixtures/doctor.snapshot.txt', import.meta.url));

const tempDirs = new Set<string>();

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'twiceshy-cli-'));
  tempDirs.add(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

interface Capture {
  io: { out(text: string): void; err(text: string): void };
  text(): string;
  errors(): string;
}

function capture(): Capture {
  let out = '';
  let err = '';
  return {
    io: {
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
    },
    text: () => out,
    errors: () => err,
  };
}

function silentLogger() {
  return createLogger({
    level: 'error',
    stream: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });
}

function writeConfig(config: unknown): string {
  const file = join(tempDir(), 'config.json');
  writeFileSync(file, JSON.stringify(config));
  return file;
}

async function seedRecords(dbPath: string): Promise<{
  succeededId: string;
  succeededFingerprint: string;
  inDoubtId: string;
  inDoubtFingerprint: string;
}> {
  const store = new SqliteStore({ path: dbPath });
  const guard = createGuard({ store, namespace: 'seed', window: '10m' });
  const ok = await guard.run(
    { tool: 'paystack.refund', args: { transaction: 'T1', amount: 1500 } },
    async () => 'R1',
  );
  await guard
    .run({ tool: 'paystack.refund', args: { transaction: 'T2', amount: 2000 } }, () => {
      throw new Error('socket hang up');
    })
    .catch(() => undefined);
  const [doubt] = await guard.list({ state: 'IN_DOUBT' });
  const result = {
    succeededId: ok.record?.id as string,
    succeededFingerprint: ok.record?.fingerprint as string,
    inDoubtId: doubt?.id as string,
    inDoubtFingerprint: doubt?.fingerprint as string,
  };
  await guard.close();
  return result;
}

async function seedOldRecord(dbPath: string): Promise<void> {
  const store = new SqliteStore({ path: dbPath });
  const guard = createGuard({
    store,
    namespace: 'old',
    window: '10m',
    clock: {
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      setTimeout: (handler, ms) => setTimeout(handler, ms),
      clearTimeout: (handle) => clearTimeout(handle),
    },
  });
  await guard.run({ tool: 'old.tool', args: {} }, async () => 'done');
  await guard.close();
}

describe('L1: commands, help, JSON, and exit codes', () => {
  it('L1: every command supports --help with a real example and exits 0', async () => {
    for (const command of ['proxy', 'doctor', 'list', 'show', 'resolve', 'allow', 'purge']) {
      const captured = capture();
      const code = await runCli([command, '--help'], { io: captured.io, logger: silentLogger() });
      expect(code, `${command} --help`).toBe(0);
      expect(captured.text()).toContain('Example:');
    }

    const global = capture();
    expect(await runCli(['--help'], { io: global.io })).toBe(0);
    expect(global.text()).toContain('Example:');
    expect(global.text()).toContain('doctor');
  });

  it('L1: bad usage exits 2 and runtime errors exit 1', async () => {
    const cases: Array<{ argv: string[]; code: number }> = [
      { argv: ['nope'], code: 2 },
      { argv: ['list', '--bogus'], code: 2 },
      { argv: ['show'], code: 2 },
      { argv: ['resolve', 'mem-1', '--by', 'kola'], code: 2 },
      { argv: ['resolve', 'mem-1', '--succeeded', '--failed', '--by', 'kola'], code: 2 },
      { argv: ['resolve', 'mem-1', '--succeeded'], code: 2 },
      { argv: ['allow', 'fp'], code: 2 },
      { argv: ['list', '--state', 'NOPE'], code: 2 },
      { argv: ['purge', '--older-than', 'soon'], code: 2 },
    ];
    const config = writeConfig({
      store: { type: 'memory' },
      mcpServers: {},
    });
    for (const testCase of cases) {
      const captured = capture();
      const code = await runCli([...testCase.argv, '--config', config], {
        io: captured.io,
        logger: silentLogger(),
        confirm: async () => false,
      });
      expect(code, testCase.argv.join(' ')).toBe(testCase.code);
    }
  });

  it('L1: list, show, resolve, allow, purge, and doctor succeed in text and --json modes', async () => {
    const dbPath = join(tempDir(), 'actions.db');
    const seeded = await seedRecords(dbPath);
    const config = writeConfig({ store: { type: 'sqlite', path: dbPath }, mcpServers: {} });

    // list
    const listText = capture();
    expect(
      await runCli(['list', '--config', config], { io: listText.io, logger: silentLogger() }),
    ).toBe(0);
    expect(listText.text()).toContain('TOOL');
    const listJson = capture();
    expect(
      await runCli(['list', '--json', '--config', config], {
        io: listJson.io,
        logger: silentLogger(),
      }),
    ).toBe(0);
    expect(JSON.parse(listJson.text())).toHaveLength(2);

    // show
    const showJson = capture();
    expect(
      await runCli(['show', seeded.succeededId, '--json', '--config', config], {
        io: showJson.io,
        logger: silentLogger(),
      }),
    ).toBe(0);
    const shown = JSON.parse(showJson.text()) as { id: string; state: string };
    expect(shown.id).toBe(seeded.succeededId);
    expect(shown.state).toBe('SUCCEEDED');

    // resolve
    const resolveJson = capture();
    expect(
      await runCli(
        [
          'resolve',
          seeded.inDoubtId,
          '--succeeded',
          '--by',
          'kola',
          '--note',
          'checked',
          '--json',
          '--config',
          config,
        ],
        { io: resolveJson.io, logger: silentLogger() },
      ),
    ).toBe(0);
    expect(JSON.parse(resolveJson.text())).toMatchObject({
      ok: true,
      state: 'RESOLVED_SUCCEEDED',
      by: 'kola',
    });

    // allow
    const allowJson = capture();
    expect(
      await runCli(
        [
          'allow',
          seeded.succeededFingerprint,
          '--by',
          'kola',
          '--note',
          'asked twice',
          '--json',
          '--config',
          config,
        ],
        { io: allowJson.io, logger: silentLogger() },
      ),
    ).toBe(0);
    expect(JSON.parse(allowJson.text())).toMatchObject({ ok: true, by: 'kola' });

    // purge with --yes (nothing is old enough)
    const purgeJson = capture();
    expect(
      await runCli(['purge', '--yes', '--json', '--config', config], {
        io: purgeJson.io,
        logger: silentLogger(),
      }),
    ).toBe(0);
    expect(JSON.parse(purgeJson.text())).toMatchObject({ ok: true, removed: 0 });

    // doctor against the working fixture server only
    const doctorConfig = writeConfig({
      store: { type: 'memory' },
      mcpServers: {
        example: { command: 'node', args: [EXAMPLE_SERVER] },
      },
    });
    const doctorJson = capture();
    expect(
      await runCli(['doctor', '--json', '--config', doctorConfig], {
        io: doctorJson.io,
        logger: silentLogger(),
        cwd: REPO_ROOT,
      }),
    ).toBe(0);
    const report = JSON.parse(doctorJson.text()) as { servers: { name: string; status: string }[] };
    expect(report.servers[0]).toMatchObject({ name: 'example', status: 'connected' });
  });

  it('L1: text output works for show, resolve, allow, purge, and an empty list', async () => {
    const dbPath = join(tempDir(), 'actions.db');
    const seeded = await seedRecords(dbPath);
    const config = writeConfig({ store: { type: 'sqlite', path: dbPath }, mcpServers: {} });

    // Empty store in text mode.
    const emptyConfig = writeConfig({ store: { type: 'memory' }, mcpServers: {} });
    const empty = capture();
    await runCli(['list', '--config', emptyConfig], { io: empty.io, logger: silentLogger() });
    expect(empty.text()).toContain('No records.');

    // Text modes and the failed-resolution variant.
    const showText = capture();
    await runCli(['show', seeded.inDoubtId, '--config', config], {
      io: showText.io,
      logger: silentLogger(),
    });
    expect(showText.text()).toContain('state:       IN_DOUBT');
    expect(showText.text()).toContain('completed:   -');

    const resolveText = capture();
    expect(
      await runCli(['resolve', seeded.inDoubtId, '--failed', '--by', 'kola', '--config', config], {
        io: resolveText.io,
        logger: silentLogger(),
      }),
    ).toBe(0);
    expect(resolveText.text()).toContain('resolved as failed by kola');

    // Multiple --state values and --since.
    const multiState = capture();
    expect(
      await runCli(
        ['list', '--state', 'IN_DOUBT', '--state', 'FAILED_DEFINITE', '--json', '--config', config],
        { io: multiState.io, logger: silentLogger() },
      ),
    ).toBe(0);
    expect(JSON.parse(multiState.text())).toHaveLength(0);
    const since = capture();
    expect(
      await runCli(['list', '--since', '1h', '--config', config], {
        io: since.io,
        logger: silentLogger(),
      }),
    ).toBe(0);

    // allow text mode without a note; list JSON now has a repeat grant.
    const allowText = capture();
    expect(
      await runCli(['allow', seeded.succeededFingerprint, '--by', 'ada', '--config', config], {
        io: allowText.io,
        logger: silentLogger(),
      }),
    ).toBe(0);
    expect(allowText.text()).toContain('One repeat allowed');
    const listAfter = capture();
    await runCli(['list', '--json', '--config', config], {
      io: listAfter.io,
      logger: silentLogger(),
    });
    const records = JSON.parse(listAfter.text()) as { repeatGrant: unknown }[];
    expect(records.some((record) => record.repeatGrant !== null)).toBe(true);

    // purge --json with a refused confirmation.
    const refusedJson = capture();
    expect(
      await runCli(['purge', '--json', '--config', config], {
        io: refusedJson.io,
        logger: silentLogger(),
        confirm: async () => false,
      }),
    ).toBe(0);
    expect(JSON.parse(refusedJson.text())).toMatchObject({ removed: 0, confirmed: false });
  });

  it('uses twiceshy.config.json in the working directory when --config is missing', async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'twiceshy.config.json'),
      JSON.stringify({ store: { type: 'memory' }, mcpServers: {} }),
    );
    const captured = capture();
    expect(
      await runCli(['list', '--json'], { io: captured.io, logger: silentLogger(), cwd: dir }),
    ).toBe(0);
    expect(JSON.parse(captured.text())).toEqual([]);
  });

  it('purge asks for confirmation and respects a typed refusal', async () => {
    const config = writeConfig({ store: { type: 'memory' }, mcpServers: {} });
    const captured = capture();
    const running = runCli(['purge', '--config', config], {
      io: captured.io,
      logger: silentLogger(),
    });
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    process.stdin.emit('data', 'n\n');
    expect(await running).toBe(0);
    expect(captured.text()).toContain('Nothing was removed');
  });

  it('L1: resolve and allow refuse the wrong record state and missing records', async () => {
    const dbPath = join(tempDir(), 'actions.db');
    const seeded = await seedRecords(dbPath);
    const config = writeConfig({ store: { type: 'sqlite', path: dbPath }, mcpServers: {} });

    const wrongState = capture();
    expect(
      await runCli(
        ['resolve', seeded.succeededId, '--failed', '--by', 'kola', '--config', config],
        { io: wrongState.io, logger: silentLogger() },
      ),
    ).toBe(1);
    expect(wrongState.errors()).toContain('SUCCEEDED');
    expect(wrongState.errors()).toContain('Why:');
    expect(wrongState.errors()).toContain('Fix:');

    const wrongAllow = capture();
    expect(
      await runCli(['allow', seeded.inDoubtFingerprint, '--by', 'kola', '--config', config], {
        io: wrongAllow.io,
        logger: silentLogger(),
      }),
    ).toBe(1);
    expect(wrongAllow.errors()).toContain('IN_DOUBT');

    const missingShow = capture();
    expect(
      await runCli(['show', 'nope', '--config', config], {
        io: missingShow.io,
        logger: silentLogger(),
      }),
    ).toBe(1);
    expect(missingShow.errors()).toContain('was not found');

    const missingAllow = capture();
    expect(
      await runCli(['allow', 'missing-fingerprint', '--by', 'kola', '--config', config], {
        io: missingAllow.io,
        logger: silentLogger(),
      }),
    ).toBe(1);
    expect(missingAllow.errors()).toContain('No record');
  });
});

describe('L3: purge confirmation', () => {
  it('L3: purge without --yes does nothing when the confirmation is refused', async () => {
    const dbPath = join(tempDir(), 'actions.db');
    await seedRecords(dbPath);
    const config = writeConfig({ store: { type: 'sqlite', path: dbPath }, mcpServers: {} });

    const refused = capture();
    const code = await runCli(['purge', '--config', config], {
      io: refused.io,
      logger: silentLogger(),
      confirm: async () => false,
    });
    expect(code).toBe(0);
    expect(refused.text()).toContain('Nothing was removed');

    const list = capture();
    await runCli(['list', '--json', '--config', config], { io: list.io, logger: silentLogger() });
    expect(JSON.parse(list.text())).toHaveLength(2);
  });

  it('L3: purge --yes removes records past retention and reports the count', async () => {
    const dbPath = join(tempDir(), 'actions.db');
    await seedOldRecord(dbPath);
    const config = writeConfig({ store: { type: 'sqlite', path: dbPath }, mcpServers: {} });

    const captured = capture();
    expect(
      await runCli(['purge', '--yes', '--json', '--config', config], {
        io: captured.io,
        logger: silentLogger(),
      }),
    ).toBe(0);
    expect(JSON.parse(captured.text())).toMatchObject({ ok: true, removed: 1, confirmed: true });
  });
});

describe('keyFields warning', () => {
  it('appears for a guarded tool with a reason field and no keyFields, and not once keyFields is set', async () => {
    const withoutKeyFields = writeConfig({
      store: { type: 'memory' },
      mcpServers: { example: { command: 'node', args: [EXAMPLE_SERVER] } },
    });
    const first = capture();
    expect(
      await runCli(['doctor', '--json', '--config', withoutKeyFields], {
        io: first.io,
        logger: silentLogger(),
        cwd: REPO_ROOT,
      }),
    ).toBe(0);
    const firstReport = JSON.parse(first.text()) as {
      servers: { tools: { name: string; warnings: string[] }[] }[];
    };
    const refund = firstReport.servers[0]?.tools.find((tool) => tool.name === 'create_refund');
    expect(refund?.warnings).toHaveLength(1);
    expect(refund?.warnings[0]).toContain('reason');
    expect(refund?.warnings[0]).toContain('keyFields');
    expect(first.text()).toContain('slip through');

    const withKeyFields = writeConfig({
      store: { type: 'memory' },
      mcpServers: {
        example: {
          command: 'node',
          args: [EXAMPLE_SERVER],
          tools: { create_refund: { keyFields: ['transaction', 'amount'] } },
        },
      },
    });
    const second = capture();
    expect(
      await runCli(['doctor', '--json', '--config', withKeyFields], {
        io: second.io,
        logger: silentLogger(),
        cwd: REPO_ROOT,
      }),
    ).toBe(0);
    const secondReport = JSON.parse(second.text()) as {
      servers: { tools: { name: string; warnings: string[] }[] }[];
    };
    const fixed = secondReport.servers[0]?.tools.find((tool) => tool.name === 'create_refund');
    expect(fixed?.warnings).toEqual([]);
  });

  it('does not warn for guarded tools without free-text fields', async () => {
    const config = writeConfig({
      store: { type: 'memory' },
      mcpServers: {
        example: {
          command: 'node',
          args: [EXAMPLE_SERVER],
          tools: {
            list_transactions: { guard: true },
            upsert: { guard: true },
            noop: { guard: true },
          },
        },
      },
    });
    const captured = capture();
    expect(
      await runCli(['doctor', '--json', '--config', config], {
        io: captured.io,
        logger: silentLogger(),
        cwd: REPO_ROOT,
      }),
    ).toBe(0);
    const report = JSON.parse(captured.text()) as {
      servers: { tools: { name: string; warnings: string[] }[] }[];
    };
    const tools = report.servers[0]?.tools ?? [];
    expect(tools.find((tool) => tool.name === 'list_transactions')?.warnings).toEqual([]);
    expect(tools.find((tool) => tool.name === 'upsert')?.warnings).toEqual([]);
    expect(tools.find((tool) => tool.name === 'noop')?.warnings).toEqual([]);
  });
});

function normalizeDoctorOutput(text: string): string {
  return text
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<timestamp>')
    .replace(/\b\d+ms\b/g, '<ms>')
    .replace(/(?:\/Users|\/home|\/private|[A-Z]:\\)[^\s"']*/g, '<path>');
}

describe('L2: doctor snapshot', () => {
  it('L2: doctor output matches the committed snapshot for one working and one broken server', async () => {
    const captured = capture();
    const code = await runCli(['doctor', '--config', EXAMPLE_CONFIG], {
      io: captured.io,
      logger: silentLogger(),
      cwd: REPO_ROOT,
    });
    expect(code).toBe(1);

    const normalized = normalizeDoctorOutput(captured.text());
    const committed = readFileSync(SNAPSHOT, 'utf8');
    expect(normalized).toBe(committed);
  });
});
