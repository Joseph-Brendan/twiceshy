import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Publishes the release tarballs in a safe order. Nothing here touches the
 * registry until the user types "yes", and the proxy is only published after
 * the core version is visible on npm.
 *
 * Run with: pnpm release:publish
 */

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const CORE_DIR = join(REPO_ROOT, 'packages', 'core');
export const PROXY_DIR = join(REPO_ROOT, 'packages', 'mcp-proxy');
export const RELEASE_DIR = join(homedir(), 'twiceshy-release');
export const REQUIRED_NPM_USER = 'devanddesignhq';
export const CORE_NAME = 'twiceshy';
export const PROXY_NAME = '@twiceshy/mcp-proxy';

/** A planned stop: the message already says what happened and what to do next. */
export class ReleaseStop extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReleaseStop';
  }
}

function quoteForCmd(arg) {
  return /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/** Runs npm and returns its exit status and captured output. */
export function defaultNpm(args, options = {}) {
  const settings = {
    cwd: options.cwd ?? RELEASE_DIR,
    encoding: 'utf8',
    stdio: options.inherit === true ? 'inherit' : 'pipe',
  };
  const result =
    process.platform === 'win32'
      ? spawnSync([`npm`, ...args].map(quoteForCmd).join(' '), { ...settings, shell: true })
      : spawnSync('npm', args, settings);
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** Reads the versions and names straight from the two package manifests. */
export function readVersions(coreDir = CORE_DIR, proxyDir = PROXY_DIR) {
  const core = JSON.parse(readFileSync(join(coreDir, 'package.json'), 'utf8'));
  const proxy = JSON.parse(readFileSync(join(proxyDir, 'package.json'), 'utf8'));
  return {
    coreName: core.name,
    coreVersion: core.version,
    proxyName: proxy.name,
    proxyVersion: proxy.version,
  };
}

/** Reads the twiceshy dependency version out of a packed proxy tarball. */
export function readProxyTarballDependency(tarball) {
  const result =
    process.platform === 'win32'
      ? spawnSync(`tar -xzOf ${quoteForCmd(tarball)} package/package.json`, {
          encoding: 'utf8',
          shell: true,
        })
      : spawnSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new ReleaseStop(
      `Could not read ${tarball} to check that it depends on the right twiceshy version. ` +
        'Nothing was published. Re-pack the proxy with "pnpm pack" and try again.',
    );
  }
  const manifest = JSON.parse(result.stdout);
  return manifest.dependencies?.twiceshy;
}

async function askYes(question) {
  if (process.stdin.isTTY !== true) {
    throw new ReleaseStop(
      'No terminal is attached, so the release cannot ask for your "yes". Nothing was published. ' +
        'Run "pnpm release:publish" in an interactive terminal.',
    );
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(question);
    return /^yes$/i.test(answer.trim());
  } catch {
    // Input ended before an answer arrived (for example, a closed stdin).
    return false;
  } finally {
    readline.close();
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Runs the guarded release. Every dependency is injectable so the order and
 * the stop rules can be tested without touching the real registry.
 */
export async function runPublishRelease(options = {}) {
  const deps = {
    npm: options.npm ?? defaultNpm,
    confirm: options.confirm ?? askYes,
    out: options.out ?? ((text) => process.stdout.write(text)),
    releaseDir: options.releaseDir ?? RELEASE_DIR,
    coreDir: options.coreDir ?? CORE_DIR,
    proxyDir: options.proxyDir ?? PROXY_DIR,
    readProxyDependency: options.readProxyDependency ?? readProxyTarballDependency,
    sleep: options.sleep ?? sleep,
    pollIntervalMs: options.pollIntervalMs ?? 10_000,
    maxPollAttempts: options.maxPollAttempts ?? 30,
  };
  const say = (line) => deps.out(`${line}\n`);

  mkdirSync(deps.releaseDir, { recursive: true });
  const npm = (args, runOptions = {}) => deps.npm(args, { cwd: deps.releaseDir, ...runOptions });

  const { coreName, coreVersion, proxyName, proxyVersion } = readVersions(
    deps.coreDir,
    deps.proxyDir,
  );
  say(`Release check for ${coreName}@${coreVersion} and ${proxyName}@${proxyVersion}.`);

  // a. Both packages must carry the same version.
  if (coreVersion !== proxyVersion) {
    throw new ReleaseStop(
      `The two packages have different versions: ${coreName} is ${coreVersion} and ${proxyName} is ${proxyVersion}. ` +
        'Nothing was published. Run "pnpm changeset version" so both packages match, build and pack again, then try again.',
    );
  }

  // b. The npm account must be the one that owns the packages.
  const whoami = await npm(['whoami']);
  if (whoami.status !== 0) {
    throw new ReleaseStop('You are not signed in to npm. Run: npm login');
  }
  const user = whoami.stdout.trim();
  if (user !== REQUIRED_NPM_USER) {
    throw new ReleaseStop(
      `npm is signed in as "${user}", but this release must be published as "${REQUIRED_NPM_USER}". ` +
        `Nothing was published. Run "npm logout", then "npm login" with the ${REQUIRED_NPM_USER} account, then try again.`,
    );
  }
  say(`Signed in to npm as ${user}.`);

  // c. Neither version may exist on npm yet.
  for (const [name, version] of [
    [coreName, coreVersion],
    [proxyName, proxyVersion],
  ]) {
    const check = await npm(['view', `${name}@${version}`, 'version']);
    if (check.status === 0 && check.stdout.trim() === version) {
      throw new ReleaseStop(
        `${name}@${version} is already published on npm. Nothing was published. ` +
          'Raise the version ("pnpm changeset version"), build and pack again, then try again.',
      );
    }
  }
  say('Neither version is on npm yet.');

  // d. The tarballs must exist and the proxy must depend on this exact core version.
  const coreTarball = join(deps.releaseDir, `${CORE_NAME}-${coreVersion}.tgz`);
  const proxyTarball = join(deps.releaseDir, `${PROXY_NAME.replace('@', '').replace('/', '-')}-${proxyVersion}.tgz`);
  if (!existsSync(coreTarball)) {
    throw new ReleaseStop(
      `The core tarball ${coreTarball} is missing. Nothing was published. ` +
        'Pack it with "pnpm pack" from packages/core into that folder, then try again.',
    );
  }
  if (!existsSync(proxyTarball)) {
    throw new ReleaseStop(
      `The proxy tarball ${proxyTarball} is missing. Nothing was published. ` +
        'Pack it with "pnpm pack" from packages/mcp-proxy into that folder, then try again.',
    );
  }
  const proxyDependency = deps.readProxyDependency(proxyTarball);
  if (proxyDependency !== coreVersion) {
    throw new ReleaseStop(
      `The proxy tarball depends on twiceshy ${String(proxyDependency)}, but this release is twiceshy ${coreVersion}. ` +
        'Nothing was published. Re-pack the proxy so its manifest points at the same version, then try again.',
    );
  }
  say('Both tarballs are present and the proxy depends on the right core version.');

  // e. Show the plan and require "yes".
  say('');
  say('About to publish, in this order:');
  say(`  1. ${coreName}@${coreVersion}  (${coreTarball})`);
  say(`  2. ${proxyName}@${proxyVersion}  (${proxyTarball})`);
  say('The proxy is only published after npm confirms the core version is live.');
  const confirmed = await deps.confirm('Type "yes" to continue: ');
  if (!confirmed) {
    throw new ReleaseStop(
      'You did not type "yes", so nothing was published. Run "pnpm release:publish" again when you are ready.',
    );
  }

  // f. Publish the core first. /g. On any failure, stop before the proxy.
  say(`Publishing ${coreName}@${coreVersion}...`);
  const corePublish = await npm(['publish', coreTarball, '--access', 'public'], {
    inherit: true,
  });
  if (corePublish.status !== 0) {
    throw new ReleaseStop(
      `Publishing ${coreName}@${coreVersion} failed (npm exit code ${corePublish.status}). ` +
        'The proxy was NOT published. Read the npm error above, fix it, and run "pnpm release:publish" again. ' +
        'If the core was actually published, raise the versions before retrying.',
    );
  }
  say(`${coreName}@${coreVersion} was accepted by npm.`);

  // h. Wait until npm shows the core version before touching the proxy.
  let coreVisible = false;
  for (let attempt = 1; attempt <= deps.maxPollAttempts; attempt += 1) {
    const check = await npm(['view', `${coreName}@${coreVersion}`, 'version']);
    if (check.status === 0 && check.stdout.trim() === coreVersion) {
      coreVisible = true;
      break;
    }
    if (attempt < deps.maxPollAttempts) {
      say(`npm has not shown ${coreName}@${coreVersion} yet (check ${attempt}). Waiting 10 seconds...`);
      await deps.sleep(deps.pollIntervalMs);
    }
  }
  if (!coreVisible) {
    throw new ReleaseStop(
      `npm did not show ${coreName}@${coreVersion} within 5 minutes of publishing it. ` +
        'The proxy was NOT published. Check https://www.npmjs.com/package/' +
        `${coreName} and run "pnpm release:publish" again once the version appears.`,
    );
  }
  say(`npm now shows ${coreName}@${coreVersion}.`);

  // i. Publish the proxy the same way.
  say(`Publishing ${proxyName}@${proxyVersion}...`);
  const proxyPublish = await npm(['publish', proxyTarball, '--access', 'public'], {
    inherit: true,
  });
  if (proxyPublish.status !== 0) {
    throw new ReleaseStop(
      `Publishing ${proxyName}@${proxyVersion} failed (npm exit code ${proxyPublish.status}). ` +
        `${coreName}@${coreVersion} is already live; only the proxy is missing. ` +
        'Fix the npm error above and run "pnpm release:publish" again.',
    );
  }

  // j. Confirm both, then print the deprecate commands without running them.
  for (const [name, version] of [
    [coreName, coreVersion],
    [proxyName, proxyVersion],
  ]) {
    const check = await npm(['view', `${name}@${version}`, 'version']);
    if (check.status !== 0 || check.stdout.trim() !== version) {
      throw new ReleaseStop(
        `npm does not show ${name}@${version} yet. The publish command did not fail, so wait a minute and check ` +
          `https://www.npmjs.com/package/${name.replace('@', '').replace('/', '-')} yourself.`,
      );
    }
  }
  say('');
  say(`${coreName}@${coreVersion} and ${proxyName}@${proxyVersion} are live on npm.`);
  say('If these exact versions ever need to be marked as unsuitable, copy and run:');
  say(`  npm deprecate ${coreName}@${coreVersion} "replace this with the reason"`);
  say(`  npm deprecate ${proxyName}@${proxyVersion} "replace this with the reason"`);
  say('Nothing above was run for you.');
  return 0;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runPublishRelease()
    .then(() => {
      process.exitCode = 0;
    })
    .catch((error) => {
      if (error instanceof ReleaseStop) {
        process.stderr.write(`${error.message}\n`);
      } else {
        process.stderr.write(
          `The release stopped because of an unexpected error: ${error instanceof Error ? error.message : String(error)}\n` +
            'Nothing was published unless npm printed otherwise. Check your npm status and run "pnpm release:publish" again.\n',
        );
      }
      process.exitCode = 1;
    });
}
