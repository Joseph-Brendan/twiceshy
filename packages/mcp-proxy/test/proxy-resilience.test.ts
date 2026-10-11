import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProxyHandle } from '../src/index.js';
import { connectAllDownstreams, createProxy, loadConfig } from '../src/index.js';
import { createInteractiveServer } from './fixtures/interactive-server.mjs';
import { createProgressServer } from './fixtures/progress-server.mjs';
import { createSurfacesServer } from './fixtures/surfaces-server.mjs';
import {
  connectToProxy,
  silentLogger,
  startInProcessProxy,
  textOf,
  waitUntil,
} from './helpers/proxy-harness.js';

const CRASHY_FIXTURE = fileURLToPath(new URL('./fixtures/crashy-server.mjs', import.meta.url));
const SURFACES_FIXTURE = fileURLToPath(new URL('./fixtures/surfaces-server.mjs', import.meta.url));

const tempDirs = new Set<string>();
const proxies = new Set<ProxyHandle>();
const clients = new Set<Client>();

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'twiceshy-resilience-'));
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

async function start(options: Parameters<typeof startInProcessProxy>[0]) {
  const started = await startInProcessProxy(options);
  proxies.add(started.proxy);
  clients.add(started.client);
  return started;
}

describe('proxy resilience', () => {
  it('P6: a crash mid-call leaves the record IN_DOUBT and the call returns DOWNSTREAM_UNAVAILABLE', async () => {
    const config = loadConfig({
      store: { type: 'memory' },
      mcpServers: {
        crashy: { command: process.execPath, args: [CRASHY_FIXTURE] },
      },
    });
    const proxy = await createProxy({ config, logger: silentLogger() });
    proxies.add(proxy);
    const client = await connectToProxy(proxy);
    clients.add(client);

    const result = await client.callTool({ name: 'crashy__crash', arguments: {} });
    expect(result.isError).toBe(true);
    const text = textOf(result.content[0]);
    expect(text).toContain('crashy');
    expect(text.toLowerCase()).toContain('unavailable');
    expect(text).toContain('Fix:');

    await waitUntil(async () => {
      const records = await proxy.store.list({ toolName: 'crash' });
      return records.some((record) => record.state === 'IN_DOUBT');
    });
  });

  it('restarts a crashed server, re-lists its tools, and re-sends list_changed', async () => {
    const config = loadConfig({
      store: { type: 'memory' },
      mcpServers: {
        crashy: { command: process.execPath, args: [CRASHY_FIXTURE] },
      },
    });
    const proxy = await createProxy({ config, logger: silentLogger() });
    proxies.add(proxy);
    const client = await connectToProxy(proxy);
    clients.add(client);

    let changes = 0;
    client.setNotificationHandler('notifications/tools/list_changed', () => {
      changes += 1;
    });

    await client.callTool({ name: 'crashy__crash', arguments: {} });
    expect(proxy.connections[0]?.status).toBe('restarting');
    await waitUntil(() => proxy.connections[0]?.status === 'connected', 10_000);
    await waitUntil(() => changes > 0, 10_000);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toContain('crashy__ping');
  });

  it('connects to a spawned server and loads its resources and prompts', async () => {
    const config = loadConfig({
      store: { type: 'memory' },
      mcpServers: {
        surfaces: { command: process.execPath, args: [SURFACES_FIXTURE] },
      },
    });
    const proxy = await createProxy({ config, logger: silentLogger() });
    proxies.add(proxy);

    await waitUntil(() => (proxy.connections[0]?.resources.length ?? 0) > 0, 10_000);
    expect(proxy.connections[0]?.resources).toHaveLength(1);
    expect(proxy.connections[0]?.resourceTemplates).toHaveLength(1);
    expect(proxy.connections[0]?.prompts).toHaveLength(1);
  });

  it('gives up after five failed restarts and reports the server as failed', async () => {
    const marker = join(tempDir(), 'first-start.marker');
    const config = loadConfig({
      store: { type: 'memory' },
      mcpServers: {
        crashy: {
          command: process.execPath,
          args: [CRASHY_FIXTURE],
          env: { TWICESHY_CRASHY_MARKER: marker },
        },
      },
    });
    const downstreams = await connectAllDownstreams(config.mcpServers, {
      logger: silentLogger(),
      // Tiny delays so the five attempts finish quickly in the test.
      restartDelaysMs: [10, 10, 10, 10, 10],
    });
    const proxy = await createProxy({ config, downstreams, logger: silentLogger() });
    proxies.add(proxy);
    const client = await connectToProxy(proxy);
    clients.add(client);

    await client.callTool({ name: 'crashy__crash', arguments: {} });
    await waitUntil(() => proxy.connections[0]?.status === 'failed', 5_000);
    expect(proxy.failures.some((failure) => failure.name === 'crashy')).toBe(true);

    const status = await client.callTool({ name: 'twiceshy_status', arguments: {} });
    expect(textOf(status.content[0])).toContain('crashy: FAILED');
  });

  it('P7: progress notifications and cancellation pass through correctly', async () => {
    const { client, proxy } = await start({
      name: 'progress',
      server: createProgressServer(),
      tools: { log: { guard: false } },
    });

    const progress: number[] = [];
    const worked = await client.callTool(
      {
        name: 'progress__work',
        arguments: { steps: 3 },
        _meta: { progressToken: 'p7-token' },
      },
      {
        onprogress: (report) => {
          progress.push(report.progress);
        },
      },
    );
    expect(textOf(worked.content[0])).toBe('worked 3');
    expect(progress).toEqual([1, 2, 3]);

    // Cancellation: the guarded call becomes IN_DOUBT (C6/C13).
    const controller = new AbortController();
    const pending = client.callTool(
      { name: 'progress__slow', arguments: {} },
      { signal: controller.signal },
    );
    await waitUntil(async () => {
      const records = await proxy.store.list({ toolName: 'slow' });
      return records.some((record) => record.state === 'IN_FLIGHT');
    });
    controller.abort();
    await expect(pending).rejects.toThrow();
    await waitUntil(async () => {
      const records = await proxy.store.list({ toolName: 'slow' });
      return records.some((record) => record.state === 'IN_DOUBT');
    });

    // Logging messages are forwarded to the client.
    const logs: unknown[] = [];
    client.setNotificationHandler('notifications/message', (notification) => {
      logs.push(notification.params.data);
    });
    const logged = await client.callTool({ name: 'progress__log', arguments: {} });
    expect(textOf(logged.content[0])).toBe('logged');
    await waitUntil(() => logs.includes('hello from downstream'));
  });

  it('P8: sampling and elicitation from downstream return UNSUPPORTED_FEATURE', async () => {
    const { client } = await start({
      name: 'interactive',
      server: createInteractiveServer(),
      tools: {
        ask_sampling: { guard: false },
        ask_elicitation: { guard: false },
      },
    });

    const sampling = await client.callTool({
      name: 'interactive__ask_sampling',
      arguments: {},
    });
    expect(sampling.isError).toBe(true);
    const samplingText = textOf(sampling.content[0]);
    expect(samplingText).toContain('sampling');
    expect(samplingText).toContain('v1.1');

    const elicitation = await client.callTool({
      name: 'interactive__ask_elicitation',
      arguments: {},
    });
    expect(elicitation.isError).toBe(true);
    const elicitationText = textOf(elicitation.content[0]);
    expect(elicitationText).toContain('elicitation');
    expect(elicitationText).toContain('v1.1');
  });

  it('list_changed from a downstream server reaches the client with the updated merged list', async () => {
    const { client } = await start({
      name: 'surfaces',
      server: createSurfacesServer(),
      tools: {
        add_resource: { guard: false },
        add_prompt: { guard: false },
        grow: { guard: false },
      },
    });

    let resourceChanges = 0;
    let promptChanges = 0;
    client.setNotificationHandler('notifications/resources/list_changed', () => {
      resourceChanges += 1;
    });
    client.setNotificationHandler('notifications/prompts/list_changed', () => {
      promptChanges += 1;
    });

    await client.callTool({ name: 'surfaces__grow', arguments: {} });
    await waitUntil(() => resourceChanges > 0 && promptChanges > 0);

    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.name).sort()).toEqual([
      'surfaces__extra',
      'surfaces__welcome',
    ]);
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((prompt) => prompt.name).sort()).toEqual([
      'surfaces__farewell',
      'surfaces__greet',
    ]);
  });

  it('resources and prompts forward with the same naming scheme as tools', async () => {
    const { client } = await start({
      name: 'surfaces',
      server: createSurfacesServer(),
      tools: { add_resource: { guard: false }, add_prompt: { guard: false } },
    });

    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.name)).toEqual(['surfaces__welcome']);

    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map((template) => template.name)).toEqual([
      'surfaces__note',
    ]);

    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((prompt) => prompt.name)).toEqual(['surfaces__greet']);

    // Reads and gets route back to the right downstream surface, by original
    // URI and exposed prompt name respectively.
    const read = await client.readResource({ uri: 'note://welcome' });
    expect(read.contents[0]?.text).toBe('content of note://welcome');

    const got = await client.getPrompt({
      name: 'surfaces__greet',
      arguments: { who: 'Ada' },
    });
    const first = got.messages[0];
    expect(first?.content.type).toBe('text');
    if (first?.content.type === 'text') {
      expect(first.content.text).toBe('Hello Ada');
    }

    // Unknown resources are an error, not a silent empty result.
    await expect(client.readResource({ uri: 'note://missing' })).rejects.toThrow(
      /no configured server/,
    );
  });
});
