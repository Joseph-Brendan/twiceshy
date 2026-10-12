import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Shared helpers for the demos. Every demo is a plain `node` process. */

export const demoDir = dirname(fileURLToPath(import.meta.url));

/** Where the `twiceshy` command lives, provided by @twiceshy/mcp-proxy. */
export function cliPath() {
  const require = createRequire(import.meta.url);
  const entry = require.resolve('@twiceshy/mcp-proxy');
  return join(dirname(entry), 'cli.js');
}

/** Prints a clear PASS or FAIL line and sets a failing exit code on FAIL. */
export function pass(name, ok, details = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${details === '' ? '' : `: ${details}`}`);
  if (!ok) {
    process.exitCode = 1;
  }
  return ok;
}

/** Runs the installed CLI as a plain child process. */
export function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath(), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      resolve({ code: 1, signal: null, stdout, stderr: `${stderr}${String(error)}` });
    });
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/**
 * Writes proxy.config.json with absolute paths built from this folder, so the
 * proxy can start from any working directory. Demo 5 adds the filesystem
 * server on top.
 */
export function writeProxyConfig(extraServers = {}) {
  const config = {
    $schema: 'https://unpkg.com/@twiceshy/mcp-proxy/schema.json',
    store: { type: 'sqlite', path: join(demoDir, 'proxy-actions.db') },
    window: '10m',
    onStoreFailure: 'closed',
    toolNaming: 'prefix',
    mcpServers: {
      counter: {
        command: process.execPath,
        args: [join(demoDir, 'counter-server.mjs')],
        env: { TWICESHY_COUNTER_FILE: join(demoDir, 'counter.txt') },
        tools: {
          create_charge: { guard: true, keyFields: ['amount'] },
          get_count: { guard: false },
        },
      },
      ...extraServers,
    },
  };
  writeFileSync(join(demoDir, 'proxy.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

export function resetFiles(names) {
  for (const name of names) {
    rmSync(join(demoDir, name), { force: true });
  }
}

/**
 * Downloads and caches an npx package once, so a later spawn does not spend
 * the proxy's 15 s connect timeout on the download (Windows is slow at this).
 */
export function warmNpxPackage(name) {
  const args = ['-y', '--package', name, '--', 'node', '-e', 'process.exit(0)'];
  return new Promise((resolve) => {
    const child =
      process.platform === 'win32'
        ? spawn(`npx ${args.join(' ')}`, { stdio: 'ignore', shell: true })
        : spawn('npx', args, { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/** A tiny JSON-RPC client for the proxy's stdio transport. */
export function startProxy(configPath) {
  const child = spawn(process.execPath, [cliPath(), 'proxy', '--config', configPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let nextId = 1;
  let buffer = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk);
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim() !== '') {
        try {
          const message = JSON.parse(line);
          if (typeof message.id === 'number' && pending.has(message.id)) {
            const entry = pending.get(message.id);
            pending.delete(message.id);
            clearTimeout(entry.timer);
            if (message.error !== undefined) {
              entry.reject(new Error(message.error.message ?? 'JSON-RPC error'));
            } else {
              entry.resolve(message.result ?? {});
            }
          }
        } catch {
          // Keep reading; a non-JSON line cannot resolve a request.
        }
      }
      index = buffer.indexOf('\n');
    }
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out waiting for ${method}`));
      }, 30_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  };
  const stop = async () => {
    child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 15_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };
  return { child, request, notify, stop, stderr: () => stderr };
}
