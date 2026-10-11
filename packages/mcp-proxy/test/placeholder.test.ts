import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { isProxyAvailable, PROXY_VERSION } from '../src/index.js';

describe('mcp-proxy placeholder', () => {
  it('exports version and availability', () => {
    expect(PROXY_VERSION).toBe('0.0.0');
    expect(isProxyAvailable()).toBe(true);
  });

  it('runs cli with version and help flags', async () => {
    expect(await runCli(['--version'])).toBe(0);
    expect(await runCli(['-v'])).toBe(0);
    expect(await runCli(['--help'])).toBe(0);
    expect(await runCli(['-h'])).toBe(0);
    expect(await runCli([])).toBe(2);
  });
});
