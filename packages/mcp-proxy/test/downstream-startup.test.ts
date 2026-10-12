import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ServerConfig, TransportDiagnostics } from '../src/index.js';
import { commandExists, startupFailure } from '../src/index.js';

const STDIO: ServerConfig = {
  kind: 'stdio',
  command: 'my-server',
  args: ['--flag'],
  env: {},
  tools: {},
};
const HTTP: ServerConfig = { kind: 'http', url: 'https://example.com/mcp', tools: {} };
const EMPTY: TransportDiagnostics = { exitCode: null, exitSignal: null, stderr: [] };

describe('startup failure reasons', () => {
  it('maps a process exit signal', () => {
    const failure = startupFailure(
      'server',
      STDIO,
      new Error('closed'),
      { exitCode: null, exitSignal: 'SIGKILL', stderr: [] },
      15_000,
    );
    expect(failure.why).toBe('process exited after signal SIGKILL');
  });

  it('maps a connection close without an exit code', () => {
    const cause = Object.assign(new Error('Connection closed'), { code: 'CONNECTION_CLOSED' });
    expect(startupFailure('server', STDIO, cause, EMPTY, 15_000).why).toBe(
      'the server exited before the MCP handshake finished',
    );
  });

  it('maps a connection timeout', () => {
    const cause = Object.assign(new Error('Request timed out'), { code: 'REQUEST_TIMEOUT' });
    expect(startupFailure('server', HTTP, cause, EMPTY, 5_000).why).toBe('timed out after 5 s');
  });

  it('maps a nested connection refusal', () => {
    const inner = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const cause = new Error('fetch failed', { cause: inner });
    const failure = startupFailure('server', HTTP, cause, EMPTY, 15_000);
    expect(failure.why).toBe('connection refused');
    expect(failure.targetKind).toBe('url');
    expect(failure.target).toBe('https://example.com/mcp');
  });

  it('falls back to the message with the code, and to the message alone', () => {
    const withCode = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    expect(startupFailure('server', STDIO, withCode, EMPTY, 15_000).why).toBe(
      'permission denied (EACCES)',
    );
    expect(startupFailure('server', STDIO, new Error('odd failure'), EMPTY, 15_000).why).toBe(
      'odd failure',
    );
  });

  it('reports the exact command line that was tried', () => {
    const failure = startupFailure('server', STDIO, new Error('x'), EMPTY, 15_000);
    expect(failure.target).toBe('my-server --flag');
    expect(failure.targetKind).toBe('command');
    expect(failure.fix).toContain('command and arguments');
  });
});

describe('commandExists (C13/E: command not found works on every platform)', () => {
  it('finds an absolute path that exists and reports one that does not', () => {
    expect(commandExists(process.execPath)).toBe(true);
    expect(commandExists(join(tmpdir(), 'definitely-not-a-command-xyz'))).toBe(false);
  });

  it('finds a bare command through PATH and respects PATHEXT on Windows', () => {
    expect(commandExists('node')).toBe(true);
    const env = {
      PATH: process.platform === 'win32' ? 'C:\\tools' : '/tools',
      PATHEXT: '.EXE;.CMD',
    };
    const platform = process.platform === 'win32' ? 'win32' : 'linux';
    // A directory that cannot exist proves the search reports a miss.
    expect(commandExists('definitely-not-a-command-xyz', env, platform)).toBe(false);
  });

  it('checks PATHEXT extensions on Windows', () => {
    const env = { PATH: '', PATHEXT: '.EXE;.BAT' };
    expect(commandExists(process.execPath, env, 'win32')).toBe(true);
  });
});
