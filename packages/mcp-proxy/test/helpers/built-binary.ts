import { execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const CLI_PATH = join(REPO_ROOT, 'packages/mcp-proxy/dist/cli.js');
export const CORE_DIST = join(REPO_ROOT, 'packages/core/dist/index.js');

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs);
  }
  return newest;
}

/**
 * The real-binary tests (P9, P11) must exercise a build that reflects the
 * sources, so build once when dist is missing or stale.
 */
export function ensureBuilt(): void {
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
