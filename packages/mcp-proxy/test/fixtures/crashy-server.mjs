import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

/**
 * A server whose `crash` tool exits the process, for the resilience tests.
 * `ping` keeps working so the fixture is usable before the crash.
 */
export function createCrashyServer() {
  const server = new Server({ name: 'crashy', version: '1.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler('tools/list', async () => ({
    tools: [
      {
        name: 'ping',
        description: 'Answers pong',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'crash',
        description: 'Makes the server process exit',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }));

  server.setRequestHandler('tools/call', async (request) => {
    if (request.params.name === 'crash') {
      process.exit(1);
    }
    return { content: [{ type: 'text', text: 'pong' }] };
  });

  return server;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createCrashyServer().connect(new StdioServerTransport());
}
