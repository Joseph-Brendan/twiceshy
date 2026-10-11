/**
 * @twiceshy/mcp-proxy entry point.
 *
 * The proxy is an MCP server to the agent's client and an MCP client to the
 * configured downstream servers (SPEC.md C13).
 */
export * from './config.js';
export * from './downstream.js';
export * from './logger.js';
export * from './naming.js';
export * from './proxy.js';
export * from './restart.js';
export { PROXY_VERSION } from './version.js';

export function isProxyAvailable(): boolean {
  return true;
}
