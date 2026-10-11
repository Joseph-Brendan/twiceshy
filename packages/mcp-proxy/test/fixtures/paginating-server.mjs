import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

/** A server whose tool list is served across three pages. */
export function createPaginatingServer({ totalTools = 5, pageSize = 2 } = {}) {
  const server = new Server(
    { name: 'paginating', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  const tools = Array.from({ length: totalTools }, (_, index) => ({
    name: `page_tool_${index + 1}`,
    description: `Tool number ${index + 1}`,
    inputSchema: { type: 'object', properties: {} },
  }));

  server.setRequestHandler('tools/list', async (request) => {
    const start = request.params?.cursor === undefined ? 0 : Number(request.params.cursor);
    const page = tools.slice(start, start + pageSize);
    const next = start + pageSize;
    return next < tools.length ? { tools: page, nextCursor: String(next) } : { tools: page };
  });

  server.setRequestHandler('tools/call', async (request) => ({
    content: [{ type: 'text', text: `called ${request.params.name}` }],
  }));

  return server;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createPaginatingServer().connect(new StdioServerTransport());
}
