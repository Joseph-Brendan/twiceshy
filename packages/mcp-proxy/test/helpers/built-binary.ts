import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const CLI_PATH = join(REPO_ROOT, 'packages/mcp-proxy/dist/cli.js');
export const CORE_DIST = join(REPO_ROOT, 'packages/core/dist/index.js');

const LOCK_DIR = join(REPO_ROOT, '.twiceshy-build.lock');
const LOCK_STALE_MS = 300_000;
const WAIT_LIMIT_MS = 180_000;
const LOCK_POLL_MS = 100;

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(sleepBuffer, 0, 0, ms);
}

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs);
  }
  return newest;
}

function distIsFresh(): boolean {
  if (!existsSync(CLI_PATH) || !existsSync(CORE_DIST)) {
    return false;
  }
  const sourcesNewest = Math.max(
    newestMtime(join(REPO_ROOT, 'packages/mcp-proxy/src')),
    newestMtime(join(REPO_ROOT, 'packages/core/src')),
  );
  const builtNewest = Math.min(statSync(CLI_PATH).mtimeMs, statSync(CORE_DIST).mtimeMs);
  return builtNewest >= sourcesNewest;
}

/**
 * The real-binary tests (P9, P11) must exercise a build that reflects the
 * sources, so build once when dist is missing or stale. Vitest runs test files
 * in parallel, so a lock directory serializes the build: two workers must not
 * clean and rewrite dist at the same time.
 */
export function ensureBuilt(): void {
  if (distIsFresh()) {
    return;
  }
  const deadline = Date.now() + WAIT_LIMIT_MS;
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      if (distIsFresh()) {
        return;
      }
      try {
        if (Date.now() - statSync(LOCK_DIR).mtimeMs > LOCK_STALE_MS) {
          rmSync(LOCK_DIR, { recursive: true, force: true });
          continue;
        }
      } catch {
        // The other worker released the lock between the checks; try again.
      }
      if (Date.now() > deadline) {
        throw new Error('timed out waiting for another worker to finish the build');
      }
      sleepSync(LOCK_POLL_MS);
    }
  }
  try {
    // Re-check under the lock: another worker may have just finished.
    if (distIsFresh()) {
      return;
    }
    execSync('pnpm build', { cwd: REPO_ROOT, stdio: 'pipe' });
  } finally {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  }
}
