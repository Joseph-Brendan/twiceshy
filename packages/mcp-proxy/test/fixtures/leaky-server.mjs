import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

/**
 * Fixture for C20 rule 19: every outward path that could expose a resolved
 * config value does so. The server prints its own environment value to stderr,
 * fails its resource listing with the value in the message, and fails every
 * tool call with the value in the error.
 */
export function createLeakyServer() {
  const secret = process.env.TWICESHY_TEST_SECRET ?? 'missing-secret';
  process.stderr.write(`leaky server booted with key ${secret}\n`);

  const server = new Server(
    { name: 'leaky', version: '1.0.0' },
    { capabilities: { tools: {}, resources: { listChanged: true } } },
  );

  server.setRequestHandler('tools/list', async () => ({
    tools: [
      {
        name: 'explode',
        description: 'Always fails with the secret in the error',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }));

  server.setRequestHandler('tools/call', async () => {
    throw new Error(`provider rejected the request with key ${secret}`);
  });

  server.setRequestHandler('resources/list', async () => {
    throw new Error(`resource listing failed with key ${secret}`);
  });

  return server;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createLeakyServer().connect(new StdioServerTransport());
}
