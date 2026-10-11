import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

/**
 * A tiny fake MCP server for the proxy tests. It speaks MCP over stdio and
 * exposes a fixed tool set per mode:
 *
 *   simple     echo + alpha (annotations, description)
 *   paginated  alpha, beta, gamma served two per page with nextCursor
 *   collide    alpha (same name as the one in "simple")
 *   broken     exits immediately with an error on stderr
 */
const mode = process.argv[2] ?? 'simple';

function makeTool(name, extra = {}) {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object', properties: {} },
    ...extra,
  };
}

const toolsByMode = {
  simple: [
    makeTool('echo', { description: 'Echoes its arguments' }),
    makeTool('alpha', { annotations: { readOnlyHint: true, idempotentHint: true } }),
  ],
  paginated: [
    makeTool('alpha', {
      description: 'Alpha from the paginated server',
      annotations: { readOnlyHint: true, idempotentHint: true },
    }),
    makeTool('beta', {
      description: 'Beta from the paginated server',
      annotations: { destructiveHint: true },
      _meta: { 'example/kept': 'yes' },
    }),
    makeTool('gamma', { description: 'No annotations at all' }),
  ],
  collide: [makeTool('alpha', { description: 'A conflicting alpha' })],
  dynamic: [
    makeTool('alpha', { description: 'Starts alone' }),
    makeTool('grow', { description: 'Adds beta and announces the change' }),
  ],
};

if (mode === 'broken') {
  process.stderr.write('fake server failed to start\n');
  process.exit(1);
}

const tools = toolsByMode[mode] ?? toolsByMode.simple;
const PAGE_SIZE = 2;

const server = new Server(
  { name: `fake-${mode}`, version: '1.0.0' },
  { capabilities: { tools: { listChanged: true } } },
);

server.setRequestHandler('tools/list', async (request) => {
  if (mode !== 'paginated') {
    return { tools };
  }
  const start = request.params?.cursor === undefined ? 0 : Number(request.params.cursor);
  const page = tools.slice(start, start + PAGE_SIZE);
  const next = start + PAGE_SIZE;
  return next < tools.length ? { tools: page, nextCursor: String(next) } : { tools: page };
});

server.setRequestHandler('tools/call', async (request) => {
  if (mode === 'dynamic' && request.params.name === 'grow') {
    if (!tools.some((tool) => tool.name === 'beta')) {
      tools.push(makeTool('beta', { description: 'Added at runtime' }));
      await server.sendToolListChanged();
    }
  }
  return {
    content: [
      {
        type: 'text',
        text: `${mode}:${request.params.name}:${JSON.stringify(request.params.arguments ?? {})}`,
      },
    ],
  };
});

await server.connect(new StdioServerTransport());
