import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';

/**
 * Shared plumbing for the X2-X4 stress tests. Every spawned child is tracked
 * so afterEach can kill it and clean up, even when a test fails.
 */

export interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const liveChildren = new Set<ChildProcess>();

export function spawnNode(args: readonly string[]): ChildProcess {
  const child = spawn(process.execPath, [...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  liveChildren.add(child);
  child.once('exit', () => liveChildren.delete(child));
  return child;
}

/** Collects a child's output; kills it if it outlives the deadline. */
export function collectChild(
  child: ChildProcess,
  timeoutMs: number,
  label: string,
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${label} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Parses the last JSON line a child printed. */
export function parseChildJson<T>(stdout: string): T {
  const line = stdout
    .trim()
    .split('\n')
    .filter((candidate) => candidate.trim().length > 0)
    .pop();
  if (line === undefined) {
    throw new Error('the child process produced no JSON output');
  }
  return JSON.parse(line) as T;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Polls until `condition` is true, or throws once the deadline passes. */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Kills every child this file spawned and waits briefly for it to die. */
export async function killRemainingChildren(): Promise<void> {
  const children = [...liveChildren];
  liveChildren.clear();
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      // On Windows there is no real SIGKILL; Node maps it to TerminateProcess,
      // which is the closest forced kill available.
      child.kill('SIGKILL');
    }
  }
  await Promise.all(children.map((child) => waitForExit(child, 5_000)));
}
