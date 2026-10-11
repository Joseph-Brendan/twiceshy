import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProxyHandle } from '../src/index.js';
import { createCounterServer } from './fixtures/counter-server.mjs';
import { startInProcessProxy, textOf } from './helpers/proxy-harness.js';

const tempDirs = new Set<string>();
const proxies = new Set<ProxyHandle>();
const clients = new Set<Client>();

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'twiceshy-proxy-tools-'));
  tempDirs.add(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all([...clients].map((client) => client.close().catch(() => undefined)));
  clients.clear();
  await Promise.all([...proxies].map((proxy) => proxy.close().catch(() => undefined)));
  proxies.clear();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

async function start(extraConfig: Record<string, unknown> = {}) {
  const counterFile = join(tempDir(), 'counter.txt');
  const started = await startInProcessProxy({
    name: 'counter',
    server: createCounterServer({ counterFile }),
    extraConfig,
  });
  proxies.add(started.proxy);
  clients.add(started.client);
  return started;
}

describe('proxy tools', () => {
  it('P12: exposes no tool that can resolve, delete, purge, or approve records', async () => {
    const { client } = await start({ exposeRecentActions: true });
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);

    expect(names).toContain('twiceshy_status');
    expect(names).toContain('twiceshy_recent_actions');
    for (const name of names) {
      expect(name).not.toMatch(/(resolve|delete|purge|approve|allow)/i);
    }

    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
    expect(byName.get('twiceshy_status')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('twiceshy_recent_actions')?.annotations?.readOnlyHint).toBe(true);

    // Even a guessed admin tool name is just an unknown tool, not a record change.
    const attempt = await client.callTool({
      name: 'twiceshy_resolve',
      arguments: { id: 'x', as: 'succeeded' },
    });
    expect(attempt.isError).toBe(true);
  });

  it('twiceshy_status reports connected servers, guarded counts, and in-doubt records', async () => {
    const { client } = await start();
    await client.callTool({ name: 'counter__create_charge', arguments: { amount: 1 } });

    const status = await client.callTool({ name: 'twiceshy_status', arguments: {} });
    expect(status.isError).not.toBe(true);
    const text = textOf(status.content[0]);
    expect(text).toContain('counter: connected, 3 tools (1 guarded)');
    expect(text).toContain('records in doubt: 0');
  });

  it('twiceshy_recent_actions is absent unless exposeRecentActions is true', async () => {
    const { client } = await start();
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain('twiceshy_recent_actions');
  });

  it('twiceshy_recent_actions lists redacted arguments only', async () => {
    const { client } = await start({ exposeRecentActions: true });
    await client.callTool({
      name: 'counter__create_charge',
      arguments: { amount: 1, pin: '8642' },
    });

    const recent = await client.callTool({ name: 'twiceshy_recent_actions', arguments: {} });
    const text = textOf(recent.content[0]);
    expect(text).toContain('create_charge');
    expect(text).toContain('[redacted]');
    expect(text).not.toContain('8642');
  });
});
