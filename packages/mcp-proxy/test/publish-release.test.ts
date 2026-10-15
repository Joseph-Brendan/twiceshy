import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runPublishRelease } from '../../../scripts/publish-release.mjs';

/**
 * These tests drive the release script with a fake npm command, so the order
 * and the stop rules are proven without touching the real registry.
 */

const tempDirs = new Set<string>();

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

interface FakeResponse {
  status?: number;
  stdout?: string;
  stderr?: string;
}

type FakeNpm = (
  args: string[],
  options?: { cwd?: string; inherit?: boolean },
) => Promise<FakeResponse>;

function fakeNpm(handler: (args: string[]) => FakeResponse): { npm: FakeNpm; calls: string[][] } {
  const calls: string[][] = [];
  const npm: FakeNpm = async (args) => {
    calls.push([...args]);
    return { status: 0, stdout: '', stderr: '', ...handler(args) };
  };
  return { npm, calls };
}

function packageDirs(
  coreVersion: string,
  proxyVersion: string,
): { coreDir: string; proxyDir: string } {
  const base = tempDir('twiceshy-release-test-');
  const coreDir = join(base, 'core');
  const proxyDir = join(base, 'proxy');
  mkdirSync(coreDir);
  mkdirSync(proxyDir);
  writeFileSync(
    join(coreDir, 'package.json'),
    JSON.stringify({ name: 'twiceshy', version: coreVersion }),
  );
  writeFileSync(
    join(proxyDir, 'package.json'),
    JSON.stringify({ name: '@twiceshy/mcp-proxy', version: proxyVersion }),
  );
  return { coreDir, proxyDir };
}

function releaseDir(version: string, options: { core?: boolean; proxy?: boolean } = {}): string {
  const dir = tempDir('twiceshy-release-files-');
  if (options.core !== false) {
    writeFileSync(join(dir, `twiceshy-${version}.tgz`), 'core tarball');
  }
  if (options.proxy !== false) {
    writeFileSync(join(dir, `twiceshy-mcp-proxy-${version}.tgz`), 'proxy tarball');
  }
  return dir;
}

function capture(): { out: (text: string) => void; text: () => string } {
  let output = '';
  return {
    out: (text) => {
      output += text;
    },
    text: () => output,
  };
}

function notSignedInNpm(): { npm: FakeNpm; calls: string[][] } {
  return fakeNpm((args) => (args[0] === 'whoami' ? { status: 1, stderr: 'not logged in' } : {}));
}

function unpublishedNpm(): { npm: FakeNpm; calls: string[][] } {
  return fakeNpm((args) => {
    if (args[0] === 'whoami') {
      return { stdout: 'devanddesignhq\n' };
    }
    if (args[0] === 'view') {
      return { status: 1, stderr: 'E404' };
    }
    return {};
  });
}

describe('publish-release stop rules', () => {
  it('a: stops when the two packages have different versions, and publishes nothing', async () => {
    const { coreDir, proxyDir } = packageDirs('0.1.2', '0.1.1');
    const { npm, calls } = unpublishedNpm();
    await expect(
      runPublishRelease({
        coreDir,
        proxyDir,
        releaseDir: releaseDir('0.1.2'),
        npm,
        confirm: async () => true,
        out: () => undefined,
      }),
    ).rejects.toThrow(/different versions/);
    expect(calls).toEqual([]);
  });

  it('b: stops with the login message when npm whoami fails', async () => {
    const { coreDir, proxyDir } = packageDirs('0.1.2', '0.1.2');
    const { npm, calls } = notSignedInNpm();
    await expect(
      runPublishRelease({
        coreDir,
        proxyDir,
        releaseDir: releaseDir('0.1.2'),
        npm,
        confirm: async () => true,
        out: () => undefined,
      }),
    ).rejects.toThrow('You are not signed in to npm. Run: npm login');
    expect(calls.some((args) => args[0] === 'publish')).toBe(false);
  });

  it('b: stops when npm is signed in as a different user', async () => {
    const { coreDir, proxyDir } = packageDirs('0.1.2', '0.1.2');
    const { npm, calls } = fakeNpm((args) =>
      args[0] === 'whoami' ? { stdout: 'somebody-else\n' } : {},
    );
    await expect(
      runPublishRelease({
        coreDir,
        proxyDir,
        releaseDir: releaseDir('0.1.2'),
        npm,
        confirm: async () => true,
        out: () => undefined,
      }),
    ).rejects.toThrow(/somebody-else/);
    expect(calls.some((args) => args[0] === 'publish')).toBe(false);
  });

  it('c: stops when the core version is already on npm', async () => {
    const { coreDir, proxyDir } = packageDirs('0.1.2', '0.1.2');
    const { npm, calls } = fakeNpm((args) => {
      if (args[0] === 'whoami') return { stdout: 'devanddesignhq\n' };
      if (args[0] === 'view' && args[1] === 'twiceshy@0.1.2') {
        return { stdout: '0.1.2\n' };
      }
      return { status: 1, stderr: 'E404' };
    });
    await expect(
      runPublishRelease({
        coreDir,
        proxyDir,
        releaseDir: releaseDir('0.1.2'),
        npm,
        confirm: async () => true,
        out: () => undefined,
      }),
    ).rejects.toThrow(/already published/);
    expect(calls.some((args) => args[0] === 'publish')).toBe(false);
  });

  it('c: stops when the proxy version is already on npm', async () => {
    const { coreDir, proxyDir } = packageDirs('0.1.2', '0.1.2');
    const { npm, calls } = fakeNpm((args) => {
      if (args[0] === 'whoami') return { stdout: 'devanddesignhq\n' };
      if (args[0] === 'view' && args[1] === '@twiceshy/mcp-proxy@0.1.2') {
        return { stdout: '0.1.2\n' };
      }
      return { status: 1, stderr: 'E404' };
    });
    await expect(
      runPublishRelease({
        coreDir,
        proxyDir,
        releaseDir: releaseDir('0.1.2'),
        npm,
        confirm: async () => true,
        out: () => undefined,
      }),
    ).rejects.toThrow(/already published/);
    expect(calls.some((args) => args[0] === 'publish')).toBe(false);
  });

  it('d: stops when a tarball is missing', async () => {
    const { coreDir, proxyDir } = packageDirs('0.1.2', '0.1.2');
    const { npm, calls } = unpublishedNpm();
    await expect(
      runPublishRelease({
        coreDir,
        proxyDir,
        releaseDir: releaseDir('0.1.2', { core: false }),
        npm,
        confirm: async () => true,
        out: () => undefined,
      }),
    ).rejects.toThrow(/core tarball .* is missing/);
    await expect(
      runPublishRelease({
        coreDir,
        proxyDir,
        releaseDir: releaseDir('0.1.2', { proxy: false }),
        npm,
        confirm: async () => true,
        out: () => undefined,
      }),
    ).rejects.toThrow(/proxy tarball .* is missing/);
    expect(calls.some((args) => args[0] === 'publish')).toBe(false);
  });

  it('d: stops when the proxy tarball depends on a different core version', async () => {
    const { coreDir, proxyDir } = packageDirs('0.1.2', '0.1.2');
    const { npm, calls } = unpublishedNpm();
    await expect(
      runPublishRelease({
        coreDir,
        proxyDir,
        releaseDir: releaseDir('0.1.2'),
        npm,
        readProxyDependency: () => '0.1.1',
        confirm: async () => true,
        out: () => undefined,
      }),
    ).rejects.toThrow(/depends on twiceshy 0\.1\.1/);
    expect(calls.some((args) => args[0] === 'publish')).toBe(false);
  });

  it('g: a failed core publish stops before the proxy is ever published', async () => {
    const { coreDir, proxyDir } = packageDirs('0.1.2', '0.1.2');
    const { npm, calls } = fakeNpm((args) => {
      if (args[0] === 'whoami') return { stdout: 'devanddesignhq\n' };
      if (args[0] === 'view') return { status: 1, stderr: 'E404' };
      if (args[0] === 'publish' && args[1].includes('twiceshy-0.1.2.tgz')) {
        return { status: 1, stderr: 'npm said no' };
      }
      return {};
    });
    await expect(
      runPublishRelease({
        coreDir,
        proxyDir,
        releaseDir: releaseDir('0.1.2'),
        npm,
        readProxyDependency: () => '0.1.2',
        confirm: async () => true,
        out: () => undefined,
      }),
    ).rejects.toThrow(/Publishing twiceshy@0\.1\.2 failed/);
    const published = calls.filter((args) => args[0] === 'publish').map((args) => args[1]);
    expect(published).toHaveLength(1);
    expect(published[0]).toContain('twiceshy-0.1.2.tgz');
  });

  it('publishes core first, waits for npm, then publishes the proxy', async () => {
    const { coreDir, proxyDir } = packageDirs('0.1.2', '0.1.2');
    let corePublished = false;
    let proxyPublished = false;
    const { npm, calls } = fakeNpm((args) => {
      if (args[0] === 'whoami') return { stdout: 'devanddesignhq\n' };
      if (args[0] === 'view') {
        if (args[1] === 'twiceshy@0.1.2' && corePublished) return { stdout: '0.1.2\n' };
        if (args[1] === '@twiceshy/mcp-proxy@0.1.2' && proxyPublished) return { stdout: '0.1.2\n' };
        return { status: 1, stderr: 'E404' };
      }
      if (args[0] === 'publish') {
        if (args[1].includes('twiceshy-0.1.2.tgz')) corePublished = true;
        if (args[1].includes('twiceshy-mcp-proxy-0.1.2.tgz')) proxyPublished = true;
        return {};
      }
      return {};
    });
    const output = capture();
    await runPublishRelease({
      coreDir,
      proxyDir,
      releaseDir: releaseDir('0.1.2'),
      npm,
      readProxyDependency: () => '0.1.2',
      confirm: async () => true,
      out: output.out,
      sleep: async () => undefined,
      maxPollAttempts: 2,
    });
    const published = calls.filter((args) => args[0] === 'publish').map((args) => args[1]);
    expect(published).toHaveLength(2);
    expect(published[0]).toContain('twiceshy-0.1.2.tgz');
    expect(published[1]).toContain('twiceshy-mcp-proxy-0.1.2.tgz');
    expect(output.text()).toContain('npm deprecate twiceshy@0.1.2');
    expect(output.text()).toContain('npm deprecate @twiceshy/mcp-proxy@0.1.2');
    expect(output.text()).toContain('Nothing above was run for you.');
  });
});
