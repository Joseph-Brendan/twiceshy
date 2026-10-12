import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { demoDir, pass, resetFiles, runCli, startProxy, writeProxyConfig } from './lib.mjs';

/**
 * Demo 4: put the proxy in front of a local MCP server without changing the
 * server. `proxy.config.json` is written at runtime with absolute paths, so it
 * works from any working directory.
 */

resetFiles(['proxy-actions.db', 'proxy-actions.db-wal', 'proxy-actions.db-shm', 'counter.txt']);
const configPath = join(demoDir, 'proxy.config.json');
writeProxyConfig();
console.log('Wrote proxy.config.json with full paths for this folder.');

const doctor = await runCli(['doctor', '--config', configPath]);
console.log(doctor.stdout.trim());
const doctorOk =
  doctor.code === 0 &&
  doctor.stdout.includes('counter') &&
  doctor.stdout.includes('create_charge') &&
  doctor.stdout.includes('GUARDED') &&
  doctor.stdout.includes('get_count') &&
  doctor.stdout.includes('open');

const proxy = startProxy(configPath);
let proxyOk = false;
let detail = '';
try {
  await proxy.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'demo4', version: '1.0.0' },
  });
  proxy.notify('notifications/initialized', {});

  const calls = [];
  for (let call = 1; call <= 3; call += 1) {
    const result = await proxy.request('tools/call', {
      name: 'counter__create_charge',
      arguments: { amount: 1500 },
    });
    const text = result.content?.[0]?.text ?? '';
    calls.push(text);
    console.log(`Charge call ${call}: ${text}`);
  }
  const count = await proxy.request('tools/call', {
    name: 'counter__get_count',
    arguments: {},
  });
  const counterFile = Number(readFileSync(join(demoDir, 'counter.txt'), 'utf8').trim());
  const firstNormal = calls[0] === 'charged 1';
  const retriesAnnotated = calls
    .slice(1)
    .every((text) => text.startsWith('Twiceshy: this action already ran'));
  const countIsOne = count.structuredContent?.count === 1 && counterFile === 1;
  proxyOk = firstNormal && retriesAnnotated && countIsOne;
  detail = `first "${calls[0]}", retries annotated ${retriesAnnotated}, count ${String(count.structuredContent?.count)}`;
} catch (error) {
  detail = String(error);
} finally {
  await proxy.stop();
}

pass(
  'Demo 4: the proxy guards an unchanged MCP server',
  doctorOk && proxyOk,
  doctorOk ? detail : `doctor failed: ${doctor.stderr.trim() || detail}`,
);
