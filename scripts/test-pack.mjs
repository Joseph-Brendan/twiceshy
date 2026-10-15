import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Packaging install test (C17 K1-K3, script "test:pack").
 *
 * Builds both packages, packs them, installs the tarballs plus better-sqlite3
 * into a fresh temporary project outside the repository, proves ESM and
 * CommonJS imports and one guarded call each, runs `npx twiceshy --help`, and
 * asserts the core runtime dependency list is zod only. The temporary project
 * is removed even when a check fails.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CORE_DIR = join(REPO_ROOT, 'packages', 'core');
const PROXY_DIR = join(REPO_ROOT, 'packages', 'mcp-proxy');
const KEEP = process.env.TWICESHY_KEEP_PACK === '1';

function quoteForCmd(arg) {
  return /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function run(command, args, cwd) {
  const result =
    process.platform === 'win32'
      ? spawnSync([command, ...args].map(quoteForCmd).join(' '), {
          cwd,
          encoding: 'utf8',
          shell: true,
        })
      : spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with status ${result.status}\n` +
        `stdout:\n${result.stdout ?? ''}\nstderr:\n${result.stderr ?? ''}`,
    );
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function pack(packageDir, destination) {
  mkdirSync(destination, { recursive: true });
  run('pnpm', ['pack', '--pack-destination', destination], packageDir);
  const tarballs = readdirSync(destination).filter((name) => name.endsWith('.tgz'));
  if (tarballs.length !== 1) {
    throw new Error(`expected one tarball in ${destination}, found ${tarballs.join(', ')}`);
  }
  return join(destination, tarballs[0]);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const workDir = mkdtempSync(join(tmpdir(), 'twiceshy-pack-'));

try {
  process.stdout.write('[test:pack] building both packages\n');
  run('pnpm', ['build'], REPO_ROOT);

  const tarballDir = join(workDir, 'tarballs');
  const coreTarball = pack(CORE_DIR, join(tarballDir, 'core'));
  const proxyTarball = pack(PROXY_DIR, join(tarballDir, 'proxy'));
  process.stdout.write(`[test:pack] packed ${coreTarball}\n`);
  process.stdout.write(`[test:pack] packed ${proxyTarball}\n`);

  const project = join(workDir, 'consumer');
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, 'package.json'),
    `${JSON.stringify({ name: 'twiceshy-consumer', version: '0.0.0', private: true, type: 'module' }, null, 2)}\n`,
  );

  process.stdout.write('[test:pack] installing tarballs and better-sqlite3 into a fresh project\n');
  // npm is the real-world installer here: pnpm would try to fetch the packed
  // proxy's rewritten "twiceshy": "0.1.1" dependency from the registry.
  run('npm', ['install', coreTarball, proxyTarball, 'better-sqlite3@^12.11.1'], project);

  // K2: ESM import and one guarded call.
  writeFileSync(
    join(project, 'esm-check.mjs'),
    `import { createGuard, MemoryStore } from 'twiceshy';
import { SqliteStore } from 'twiceshy/sqlite';

const guard = createGuard({ store: new MemoryStore(), window: '10m' });
const outcome = await guard.run({ tool: 'pack.esm', args: { id: 1 } }, async () => ({ ok: true }));
if (outcome.status !== 'executed' || outcome.value?.ok !== true) {
  throw new Error('ESM guarded call failed: ' + JSON.stringify(outcome.status));
}
await guard.close();

const sqlite = new SqliteStore({ path: './esm-actions.db' });
const decided = await sqlite.begin({
  fingerprint: 'fp-esm',
  explicitKey: null,
  serverId: 'local',
  toolName: 'pack.tool',
  scope: '',
  redactedArgs: {},
  now: new Date(),
  settings: { windowMs: 600000, waitForInFlightMs: 100, leaseMs: 1000 },
});
if (decided.kind !== 'execute') throw new Error('ESM sqlite begin failed: ' + decided.kind);
await sqlite.close();
process.stdout.write('[test:pack] esm ok\\n');
`,
  );
  const esm = run('node', ['esm-check.mjs'], project);
  process.stdout.write(esm.stdout);

  // K2: CommonJS require and one guarded call.
  writeFileSync(
    join(project, 'cjs-check.cjs'),
    `const { createGuard, MemoryStore } = require('twiceshy');
const { SqliteStore } = require('twiceshy/sqlite');

(async () => {
  const guard = createGuard({ store: new MemoryStore(), window: '10m' });
  const outcome = await guard.run({ tool: 'pack.cjs', args: { id: 1 } }, async () => 'ok');
  if (outcome.status !== 'executed' || outcome.value !== 'ok') {
    throw new Error('CJS guarded call failed: ' + outcome.status);
  }
  await guard.close();

  const sqlite = new SqliteStore({ path: './cjs-actions.db' });
  await sqlite.close();
  process.stdout.write('[test:pack] cjs ok\\n');
})().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error) + '\\n');
  process.exitCode = 1;
});
`,
  );
  const cjs = run('node', ['cjs-check.cjs'], project);
  process.stdout.write(cjs.stdout);

  // K2: the packed binary works through npx, with its shebang intact.
  const installedCli = join(project, 'node_modules', '@twiceshy', 'mcp-proxy', 'dist', 'cli.js');
  if (!readFileSync(installedCli, 'utf8').startsWith('#!/usr/bin/env node')) {
    throw new Error('the installed CLI lost its shebang');
  }
  const npx = run('npx', ['--no-install', 'twiceshy', '--help'], project);
  if (!npx.stdout.includes('Usage: twiceshy')) {
    throw new Error(`npx twiceshy --help printed unexpected output:\n${npx.stdout}\n${npx.stderr}`);
  }
  process.stdout.write('[test:pack] npx twiceshy --help ok\n');

  // K3: the core runtime dependency list is zod only.
  const coreManifest = join(project, 'node_modules', 'twiceshy', 'package.json');
  const proxyManifest = join(project, 'node_modules', '@twiceshy', 'mcp-proxy', 'package.json');
  if (!existsSync(coreManifest) || !existsSync(proxyManifest)) {
    throw new Error('both packages must be installed in the consumer project');
  }
  const dependencies = Object.keys(readJson(coreManifest).dependencies ?? {}).sort();
  if (dependencies.length !== 1 || dependencies[0] !== 'zod') {
    throw new Error(`expected core dependencies to be exactly ["zod"], got ${JSON.stringify(dependencies)}`);
  }
  process.stdout.write('[test:pack] K3 ok: core dependencies are zod only\n');

  process.stdout.write('[test:pack] all packaging checks passed\n');
} finally {
  if (KEEP) {
    process.stdout.write(`[test:pack] kept temporary project at ${workDir}\n`);
  } else {
    rmSync(workDir, { recursive: true, force: true });
  }
}
