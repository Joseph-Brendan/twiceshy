import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Real-user smoke test (C17, script "test:smoke").
 *
 * Builds and packs both packages, installs the tarballs plus better-sqlite3
 * into a fresh temporary project outside the repository, copies the official
 * demos and the smoke scenarios in, and runs them as plain `node` processes,
 * not inside Vitest. It also runs the CLI's documented no-install form
 * (`npx -y @twiceshy/mcp-proxy ...`) against the database the demos created.
 *
 * Every SqliteStore scenario runs 20 times by default because native crashes
 * can depend on timing. Set SMOKE_REPEATS to change the count, or
 * TWICESHY_KEEP_SMOKE=1 to keep the temporary folder for inspection.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CORE_DIR = join(REPO_ROOT, 'packages', 'core');
const PROXY_DIR = join(REPO_ROOT, 'packages', 'mcp-proxy');
const DEMOS_DIR = join(REPO_ROOT, 'examples', 'demos');
const SCENARIOS_DIR = join(REPO_ROOT, 'scripts', 'smoke');
const REPEATS = Number(process.env.SMOKE_REPEATS ?? '20');
const KEEP = process.env.TWICESHY_KEEP_SMOKE === '1';

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
      `${command} ${args.join(' ')} failed with status ${String(result.status)} ` +
        `signal ${String(result.signal)} error ${result.error === undefined ? 'none' : String(result.error)}\n` +
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

function runPlainNode(script, cwd) {
  const result = spawnSync(process.execPath, [script], {
    cwd,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function assertPlainNode(name, script, cwd, expectPass) {
  const result = runPlainNode(script, cwd);
  const output = `${result.stdout}${result.stderr}`;
  process.stdout.write(output.endsWith('\n') || output === '' ? output : `${output}\n`);
  if (result.error !== undefined) {
    throw new Error(`${name} could not run: ${String(result.error)}`);
  }
  if (result.signal !== null) {
    throw new Error(`${name} was killed by signal ${String(result.signal)}`);
  }
  if (result.status !== 0) {
    throw new Error(`${name} exited with code ${String(result.status)}`);
  }
  if (expectPass && !/^PASS /m.test(result.stdout)) {
    throw new Error(`${name} did not print a PASS line`);
  }
  return result;
}

const workDir = mkdtempSync(join(tmpdir(), 'twiceshy-smoke-'));
process.stdout.write(`[test:smoke] work folder: ${workDir}\n`);

try {
  process.stdout.write('[test:smoke] building both packages\n');
  run('pnpm', ['build'], REPO_ROOT);

  const tarballDir = join(workDir, 'tarballs');
  const coreTarball = pack(CORE_DIR, join(tarballDir, 'core'));
  const proxyTarball = pack(PROXY_DIR, join(tarballDir, 'proxy'));
  process.stdout.write(`[test:smoke] packed ${coreTarball}\n`);
  process.stdout.write(`[test:smoke] packed ${proxyTarball}\n`);

  const project = join(workDir, 'consumer');
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, 'package.json'),
    `${JSON.stringify(
      { name: 'twiceshy-smoke-consumer', version: '0.0.0', private: true, type: 'module' },
      null,
      2,
    )}\n`,
  );
  process.stdout.write('[test:smoke] installing the tarballs and better-sqlite3\n');
  // The default is the README install command word for word, with the tarballs
  // standing in for the published packages. The CI driver matrix overrides the
  // major with TWICESHY_SMOKE_BETTER_SQLITE3 so every supported line is tested.
  const betterSqlite3Spec = process.env.TWICESHY_SMOKE_BETTER_SQLITE3
    ? `better-sqlite3@^${process.env.TWICESHY_SMOKE_BETTER_SQLITE3}`
    : 'better-sqlite3';
  run('npm', ['install', coreTarball, proxyTarball, betterSqlite3Spec], project);

  const demos = join(project, 'demos');
  cpSync(DEMOS_DIR, demos, {
    recursive: true,
    filter: (source) => !source.includes(`${sep}node_modules`),
  });
  const scenarios = join(project, 'smoke');
  cpSync(SCENARIOS_DIR, scenarios, { recursive: true });

  process.stdout.write('[test:smoke] running demos 1 to 5 as plain node processes\n');
  for (let demo = 1; demo <= 5; demo += 1) {
    assertPlainNode(`Demo ${demo}`, join(demos, `demo${demo}.js`), demos, true);
  }

  process.stdout.write('[test:smoke] running demo6 (timings only)\n');
  const demo6 = assertPlainNode('Demo 6', join(demos, 'demo6.js'), demos, false);
  for (const line of ['MemoryStore:', 'SqliteStore:']) {
    if (!demo6.stdout.includes(line)) {
      throw new Error(`Demo 6 did not print "${line}"`);
    }
  }

  process.stdout.write(`[test:smoke] running SqliteStore scenarios ${REPEATS} times each\n`);
  for (const name of ['close-running', 'close-late', 'exit-without-close', 'call-after-close']) {
    for (let repeat = 1; repeat <= REPEATS; repeat += 1) {
      try {
        assertPlainNode(`${name} run ${repeat}`, join(scenarios, `${name}.mjs`), scenarios, true);
      } catch (error) {
        throw new Error(`${name} failed on run ${repeat}/${REPEATS}: ${String(error)}`);
      }
    }
    process.stdout.write(`[test:smoke] ${name}: ${REPEATS}/${REPEATS} runs passed\n`);
  }

  process.stdout.write('[test:smoke] running CLI list, show, and resolve against the demo database\n');
  // The CLI runs from the consumer root (where npx finds the locally installed
  // proxy) with a config that points at the absolute demo database path.
  const smokeConfig = join(project, 'smoke.config.json');
  writeFileSync(
    smokeConfig,
    `${JSON.stringify(
      { store: { type: 'sqlite', path: join(demos, 'demo.db') }, mcpServers: {} },
      null,
      2,
    )}\n`,
  );
  const list = run('npx', ['-y', '@twiceshy/mcp-proxy', 'list', '--config', smokeConfig], project);
  process.stdout.write(list.stdout);
  const records = JSON.parse(
    run(
      'npx',
      ['-y', '@twiceshy/mcp-proxy', 'list', '--json', '--config', smokeConfig],
      project,
    ).stdout,
  );
  const inDoubt = records.find((record) => record.redactedArgs?.transaction === 'T1000');
  if (inDoubt === undefined) {
    throw new Error('the demo database has no in-doubt T1000 record to resolve');
  }
  const shown = run(
    'npx',
    ['-y', '@twiceshy/mcp-proxy', 'show', inDoubt.id, '--config', smokeConfig],
    project,
  );
  if (!shown.stdout.includes(inDoubt.id)) {
    throw new Error('twiceshy show did not print the record id');
  }
  const resolved = run(
    'npx',
    [
      '-y',
      '@twiceshy/mcp-proxy',
      'resolve',
      inDoubt.id,
      '--succeeded',
      '--by',
      'Smoke',
      '--config',
      smokeConfig,
    ],
    project,
  );
  if (!resolved.stdout.includes('resolved as succeeded')) {
    throw new Error('twiceshy resolve did not confirm the resolution');
  }
  process.stdout.write('[test:smoke] CLI list, show, and resolve passed\n');
  process.stdout.write('[test:smoke] all smoke checks passed\n');
} catch (error) {
  process.stderr.write(`[test:smoke] FAILED: ${String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (KEEP) {
    process.stdout.write(`[test:smoke] keeping ${workDir}\n`);
  } else {
    rmSync(workDir, { recursive: true, force: true });
  }
}
