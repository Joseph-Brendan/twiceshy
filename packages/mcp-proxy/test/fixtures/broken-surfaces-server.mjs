import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

/**
 * Fixture for C20 rule 10: advertises resources and prompts but every list
 * call fails. The proxy must log the failure at warn and show it in status
 * and doctor instead of pretending the surfaces are empty.
 */
export function createBrokenSurfacesServer() {
  const server = new Server(
    { name: 'broken-surfaces', version: '1.0.0' },
    {
      capabilities: { tools: {}, resources: { listChanged: true }, prompts: { listChanged: true } },
    },
  );

  server.setRequestHandler('tools/list', async () => ({
    tools: [
      {
        name: 'ping',
        description: 'Does nothing',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }));

  server.setRequestHandler('resources/list', async () => {
    throw new Error('resource listing exploded');
  });
  server.setRequestHandler('prompts/list', async () => {
    throw new Error('prompt listing exploded');
  });

  server.setRequestHandler('tools/call', async () => ({
    content: [{ type: 'text', text: 'pong' }],
  }));

  return server;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createBrokenSurfacesServer().connect(new StdioServerTransport());
}
