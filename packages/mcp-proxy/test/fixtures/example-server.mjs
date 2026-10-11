import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

/**
 * The example server used by the doctor fixture and snapshot: four tools
 * covering config rules, annotations, and a free-text `reason` field that
 * triggers the keyFields warning.
 */
export function createExampleServer() {
  const server = new Server({ name: 'example', version: '1.0.0' }, { capabilities: { tools: {} } });

  const tools = [
    {
      name: 'create_refund',
      description: 'Refunds a payment',
      inputSchema: {
        type: 'object',
        properties: {
          transaction: { type: 'string' },
          amount: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['transaction', 'amount'],
      },
    },
    {
      name: 'list_transactions',
      description: 'Lists transactions',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'get_balance',
      description: 'Reads the balance',
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
    {
      name: 'leave_message',
      description: 'Has two free-text fields',
      inputSchema: {
        type: 'object',
        properties: {
          note: { type: 'string' },
          message: { type: 'string' },
        },
      },
    },
    {
      name: 'noop',
      description: 'Has no arguments at all',
      inputSchema: { type: 'object' },
    },
  ];

  server.setRequestHandler('tools/list', async () => ({ tools }));
  server.setRequestHandler('tools/call', async (request) => ({
    content: [{ type: 'text', text: `ok ${request.params.name}` }],
  }));

  return server;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pidFile = process.env.TWICESHY_EXAMPLE_PID_FILE;
  if (pidFile !== undefined) {
    writeFileSync(pidFile, String(process.pid));
  }
  await createExampleServer().connect(new StdioServerTransport());
}
