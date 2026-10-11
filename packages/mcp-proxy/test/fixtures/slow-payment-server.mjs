import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { incrementCounter, readCounter } from './counter-file.mjs';

/**
 * The Kola scenario. `charge` commits (increments the counter) first and only
 * then waits before replying, so a caller that times out cannot know whether
 * the charge happened.
 */
export function createSlowPaymentServer({ counterFile, replyDelayMs = 500 }) {
  const server = new Server(
    { name: 'slow-payment', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler('tools/list', async () => ({
    tools: [
      {
        name: 'charge',
        description: 'Charges the card, then delays its reply',
        inputSchema: {
          type: 'object',
          properties: { amount: { type: 'number' } },
          required: ['amount'],
        },
      },
    ],
  }));

  server.setRequestHandler('tools/call', async (request) => {
    if (request.params.name !== 'charge') {
      return {
        isError: true,
        content: [{ type: 'text', text: `unknown tool ${request.params.name}` }],
      };
    }
    const count = incrementCounter(counterFile);
    await new Promise((resolve) => {
      setTimeout(resolve, replyDelayMs);
    });
    return { content: [{ type: 'text', text: `charged ${count}` }], structuredContent: { count } };
  });

  return server;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const counterFile = process.env.TWICESHY_COUNTER_FILE;
  if (counterFile === undefined) {
    process.stderr.write('TWICESHY_COUNTER_FILE is required\n');
    process.exit(1);
  }
  const replyDelayMs = Number(process.env.TWICESHY_SLOW_REPLY_MS ?? '500');
  await createSlowPaymentServer({ counterFile, replyDelayMs }).connect(new StdioServerTransport());
}

/** Exposed for the standalone counter helper used by tests. */
export { readCounter };
