import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

/**
 * The local MCP server used by Demo 4 and Demo 5. `create_charge` has no
 * annotations and is guarded by default; `get_count` is read-only; `upsert`
 * claims repeats are harmless. The counter lives in a file so the demo can
 * read it from outside the server. This is the same behaviour as the counter
 * fixture used by the package's own tests.
 */
function readCounter(file) {
  try {
    const text = readFileSync(file, 'utf8').trim();
    return text === '' ? 0 : Number(text);
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
}

function incrementCounter(file) {
  const next = readCounter(file) + 1;
  writeFileSync(file, String(next));
  return next;
}

export function createCounterServer({ counterFile }) {
  const server = new Server({ name: 'counter', version: '1.0.0' }, { capabilities: { tools: {} } });

  const tools = [
    {
      name: 'create_charge',
      description: 'Creates a charge and increments the shared counter',
      inputSchema: {
        type: 'object',
        properties: { amount: { type: 'number' } },
        required: ['amount'],
      },
    },
    {
      name: 'get_count',
      description: 'Reads the shared counter',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'upsert',
      description: 'Claims repeats are harmless',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      annotations: { idempotentHint: true },
    },
  ];

  server.setRequestHandler('tools/list', async () => ({ tools }));

  server.setRequestHandler('tools/call', async (request) => {
    const { name, arguments: args } = request.params;
    if (name === 'create_charge') {
      const count = incrementCounter(counterFile);
      return {
        content: [{ type: 'text', text: `charged ${count}` }],
        structuredContent: { count },
      };
    }
    if (name === 'get_count') {
      const count = readCounter(counterFile);
      return { content: [{ type: 'text', text: String(count) }], structuredContent: { count } };
    }
    if (name === 'upsert') {
      return { content: [{ type: 'text', text: `upserted ${String(args?.id ?? '')}` }] };
    }
    return { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] };
  });

  return server;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const counterFile = process.env.TWICESHY_COUNTER_FILE;
  if (counterFile === undefined) {
    process.stderr.write('TWICESHY_COUNTER_FILE is required\n');
    process.exit(1);
  }
  await createCounterServer({ counterFile }).connect(new StdioServerTransport());
}
