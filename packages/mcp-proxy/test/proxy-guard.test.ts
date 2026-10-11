import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import { Server } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProxyHandle } from '../src/index.js';
import { createCounterServer } from './fixtures/counter-server.mjs';
import { createPaginatingServer } from './fixtures/paginating-server.mjs';
import { createSlowPaymentServer } from './fixtures/slow-payment-server.mjs';
import { startInProcessProxy, textOf, waitUntil } from './helpers/proxy-harness.js';

const tempDirs = new Set<string>();
const proxies = new Set<ProxyHandle>();
const clients = new Set<Client>();

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'twiceshy-guard-proxy-'));
  tempDirs.add(dir);
  return dir;
}

function countIn(file: string): number {
  if (!existsSync(file)) {
    return 0;
  }
  const text = readFileSync(file, 'utf8').trim();
  return text === '' ? 0 : Number(text);
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

async function start(options: Parameters<typeof startInProcessProxy>[0]) {
  const started = await startInProcessProxy(options);
  proxies.add(started.proxy);
  clients.add(started.client);
  return started;
}

describe('guarded proxy', () => {
  it('P2: a guarded call retried three times charges once, and the retries carry the duplicate text and _meta', async () => {
    const counterFile = join(tempDir(), 'counter.txt');
    const { client } = await start({
      name: 'counter',
      server: createCounterServer({ counterFile }),
    });

    const first = await client.callTool({
      name: 'counter__create_charge',
      arguments: { amount: 1500 },
    });
    expect(first.isError).not.toBe(true);
    expect(first.structuredContent).toEqual({ count: 1 });

    for (let retryNumber = 0; retryNumber < 2; retryNumber += 1) {
      const retry = await client.callTool({
        name: 'counter__create_charge',
        arguments: { amount: 1500 },
      });
      expect(retry.isError).not.toBe(true);
      expect(textOf(retry.content[0])).toMatch(
        /Twiceshy: this action already ran at \d{2}:\d{2}:\d{2} UTC and was not repeated\./,
      );
      expect(textOf(retry.content[0])).toContain('a person must approve the repeat');
      // The original result follows the note, unchanged.
      expect(retry.content[1]).toEqual({ type: 'text', text: 'charged 1' });
      expect(retry.structuredContent).toEqual({ count: 1 });
      expect(retry._meta?.['dev.twiceshy/outcome']).toMatchObject({
        status: 'duplicate',
        originalAt: expect.any(String),
      });
    }

    expect(countIn(counterFile)).toBe(1);
  });

  it('P3: the Kola scenario times out, blocks the retry, charges once, then upgrades through late completion', async () => {
    const counterFile = join(tempDir(), 'counter.txt');
    const { client, proxy } = await start({
      name: 'slow-payment',
      server: createSlowPaymentServer({ counterFile, replyDelayMs: 600 }),
      tools: { charge: { timeoutMs: 200 } },
    });

    const first = await client.callTool({
      name: 'slow-payment__charge',
      arguments: { amount: 1500 },
    });
    expect(first.isError).toBe(true);
    expect(textOf(first.content[0]).toLowerCase()).toContain('in doubt');

    const retry = await client.callTool({
      name: 'slow-payment__charge',
      arguments: { amount: 1500 },
    });
    expect(retry.isError).toBe(true);
    const retryText = textOf(retry.content[0]);
    expect(retryText).toContain('Why:');
    expect(retryText).toContain('Fix:');
    expect(retryText.toLowerCase()).toContain('doubt');

    // The charge committed once, even though the caller could not know.
    expect(countIn(counterFile)).toBe(1);

    // The slow reply then arrives and upgrades the record (C6).
    await waitUntil(async () => {
      const records = await proxy.store.list({ toolName: 'charge' });
      return records.some((record) => record.state === 'SUCCEEDED');
    });
    const [record] = await proxy.store.list({ toolName: 'charge' });
    expect(record?.state).toBe('SUCCEEDED');
    expect(record?.result).toMatchObject({ structuredContent: { count: 1 } });
  });

  it('P4: read-only and trusted idempotent tools forward untouched and create no record', async () => {
    const counterFile = join(tempDir(), 'counter.txt');
    const { client, proxy, connection } = await start({
      name: 'counter',
      server: createCounterServer({ counterFile }),
    });

    const read = await client.callTool({ name: 'counter__get_count', arguments: {} });
    const directRead = await connection.client.callTool({ name: 'get_count', arguments: {} });
    expect(read).toEqual(directRead);

    const upsert = await client.callTool({ name: 'counter__upsert', arguments: { id: 'a' } });
    const directUpsert = await connection.client.callTool({
      name: 'upsert',
      arguments: { id: 'a' },
    });
    expect(upsert).toEqual(directUpsert);

    expect(await proxy.store.list({})).toEqual([]);
  });

  it('with annotateDuplicates false the duplicate is the original result plus only _meta', async () => {
    const counterFile = join(tempDir(), 'counter.txt');
    const { client } = await start({
      name: 'counter',
      server: createCounterServer({ counterFile }),
      extraConfig: { annotateDuplicates: false },
    });

    const first = await client.callTool({
      name: 'counter__create_charge',
      arguments: { amount: 1500 },
    });
    const retry = await client.callTool({
      name: 'counter__create_charge',
      arguments: { amount: 1500 },
    });

    expect(retry.content).toEqual(first.content);
    expect(retry.structuredContent).toEqual(first.structuredContent);
    expect(retry.isError).toEqual(first.isError);
    expect(retry._meta?.['dev.twiceshy/outcome']).toMatchObject({ status: 'duplicate' });
  });

  it('reads a downstream tool list spread over three pages', async () => {
    const { client } = await start({ name: 'paginating', server: createPaginatingServer() });
    const listed = await client.listTools();
    const names = listed.tools
      .map((tool) => tool.name)
      .filter((name) => name.startsWith('paginating__'))
      .sort();
    expect(names).toEqual([
      'paginating__page_tool_1',
      'paginating__page_tool_2',
      'paginating__page_tool_3',
      'paginating__page_tool_4',
      'paginating__page_tool_5',
    ]);
  });

  it('classifies a downstream isError result as ambiguous by default', async () => {
    const failing = new Server(
      { name: 'failing', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    failing.setRequestHandler('tools/list', async () => ({
      tools: [
        {
          name: 'explode',
          description: 'Always reports a failure result',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    }));
    failing.setRequestHandler('tools/call', async () => ({
      isError: true,
      content: [{ type: 'text', text: 'the provider said no' }],
    }));

    const { client, proxy } = await start({ name: 'failing', server: failing });
    const result = await client.callTool({ name: 'failing__explode', arguments: {} });

    // The caller gets the tool's own result, but the record is in doubt.
    expect(result.isError).toBe(true);
    expect(textOf(result.content[0])).toBe('the provider said no');
    const [record] = await proxy.store.list({ toolName: 'explode' });
    expect(record?.state).toBe('IN_DOUBT');
  });

  it('treatToolErrorsAsDefinite marks an isError result as a definite failure', async () => {
    const failing = new Server(
      { name: 'failing', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    failing.setRequestHandler('tools/list', async () => ({
      tools: [
        {
          name: 'explode',
          description: 'Always reports a failure result',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    }));
    failing.setRequestHandler('tools/call', async () => ({
      isError: true,
      content: [{ type: 'text', text: 'the provider rejected it' }],
    }));

    const { client, proxy } = await start({
      name: 'failing',
      server: failing,
      tools: { explode: { treatToolErrorsAsDefinite: true } },
    });
    const result = await client.callTool({ name: 'failing__explode', arguments: {} });
    expect(result.isError).toBe(true);
    const [record] = await proxy.store.list({ toolName: 'explode' });
    expect(record?.state).toBe('FAILED_DEFINITE');
  });
});
