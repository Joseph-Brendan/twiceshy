import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface Manifest {
  name?: string;
  version?: string;
  description?: string;
  keywords?: string[];
  author?: string;
  license?: string;
  repository?: { url?: string; directory?: string };
  type?: string;
  bin?: Record<string, string>;
  files?: string[];
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  exports?: Record<string, unknown>;
}

function readManifest(relativePath: string): Manifest {
  const path = fileURLToPath(new URL(relativePath, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

const EXPECTED_KEYWORDS = ['mcp', 'ai-agents', 'idempotency', 'retries', 'duplicate-prevention'];

function expectCommonFields(manifest: Manifest, directory: string): void {
  expect(manifest.version).toBe('0.1.0');
  expect(manifest.description).toBeTruthy();
  expect(manifest.keywords).toEqual(EXPECTED_KEYWORDS);
  expect(manifest.author).toBe('Joseph Brendan');
  expect(manifest.license).toBe('MIT');
  expect(manifest.repository?.url).toBe('git+https://github.com/Joseph-Brendan/twiceshy.git');
  expect(manifest.repository?.directory).toBe(directory);
  expect(manifest.engines?.node?.startsWith('>=22')).toBe(true);
}

function expectTypesCondition(condition: unknown): void {
  expect(condition).toMatchObject({
    types: expect.stringMatching(/\.d\.(ts|cts)$/),
    default: expect.stringMatching(/\.(js|cjs)$/),
  });
}

describe('packaging manifests (K1/K3)', () => {
  const core = readManifest('../package.json');
  const proxy = readManifest('../../mcp-proxy/package.json');

  it('core has the required metadata, exports, files, and engines', () => {
    expectCommonFields(core, 'packages/core');
    expect(core.name).toBe('twiceshy');
    expect(core.type).toBe('module');

    const exportsMap = core.exports as Record<string, Record<string, unknown>>;
    expectTypesCondition(exportsMap['.']?.import);
    expectTypesCondition(exportsMap['.']?.require);
    expectTypesCondition(exportsMap['./sqlite']?.import);
    expectTypesCondition(exportsMap['./sqlite']?.require);

    expect(core.files).toEqual(['dist', 'README.md', 'LICENSE']);
    expect(existsSync(fileURLToPath(new URL('../README.md', import.meta.url)))).toBe(true);
    expect(existsSync(fileURLToPath(new URL('../LICENSE', import.meta.url)))).toBe(true);
  });

  it('K3: core depends on zod only, with better-sqlite3 as an optional peer', () => {
    expect(Object.keys(core.dependencies ?? {}).sort()).toEqual(['zod']);
    expect(core.peerDependencies?.['better-sqlite3']).toMatch(/^\^12\./);
    expect(core.peerDependenciesMeta?.['better-sqlite3']?.optional).toBe(true);
  });

  it('proxy has both bins, minor-pinned SDK dependencies, and the published files', () => {
    expectCommonFields(proxy, 'packages/mcp-proxy');
    expect(proxy.name).toBe('@twiceshy/mcp-proxy');
    expect(proxy.bin?.twiceshy).toBe('./dist/cli.js');
    expect(proxy.bin?.['mcp-proxy']).toBe('./dist/cli.js');
    expect(proxy.dependencies?.['@modelcontextprotocol/client']).toBe('~2.3.1');
    expect(proxy.dependencies?.['@modelcontextprotocol/server']).toBe('~2.3.1');
    expect(proxy.files).toEqual(['dist', 'schema.json', 'README.md', 'LICENSE']);
    expect(existsSync(fileURLToPath(new URL('../../mcp-proxy/README.md', import.meta.url)))).toBe(
      true,
    );
    expect(existsSync(fileURLToPath(new URL('../../mcp-proxy/LICENSE', import.meta.url)))).toBe(
      true,
    );
  });
});
