import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

/**
 * Progress, cancellation, and logging fixture.
 *   work  sends `steps` progress notifications on the caller's token
 *   slow  writes a start marker, waits, then replies (cancellation/shutdown)
 *   log   sends a logging notification to the client
 */
export function createProgressServer({ replyDelayMs = 800, startFile } = {}) {
  const server = new Server(
    { name: 'progress', version: '1.0.0' },
    { capabilities: { tools: {}, logging: {} } },
  );

  server.setRequestHandler('tools/list', async () => ({
    tools: [
      {
        name: 'work',
        description: 'Sends progress notifications, then returns',
        inputSchema: {
          type: 'object',
          properties: { steps: { type: 'number' } },
        },
      },
      {
        name: 'slow',
        description: 'Waits before replying',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'log',
        description: 'Sends a log message, then returns',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }));

  server.setRequestHandler('tools/call', async (request, ctx) => {
    const { name, arguments: args } = request.params;
    if (name === 'work') {
      const token = request.params._meta?.progressToken;
      const steps = Number(args?.steps ?? 3);
      for (let step = 1; step <= steps; step += 1) {
        if (token !== undefined) {
          await ctx.mcpReq.notify({
            method: 'notifications/progress',
            params: { progressToken: token, progress: step, total: steps },
          });
        }
      }
      return { content: [{ type: 'text', text: `worked ${steps}` }] };
    }
    if (name === 'slow') {
      if (startFile !== undefined) {
        writeFileSync(startFile, 'started');
      }
      await new Promise((resolve) => {
        setTimeout(resolve, replyDelayMs);
      });
      return { content: [{ type: 'text', text: 'slow done' }] };
    }
    if (name === 'log') {
      await server.sendLoggingMessage({
        level: 'info',
        logger: 'progress-server',
        data: 'hello from downstream',
      });
      return { content: [{ type: 'text', text: 'logged' }] };
    }
    return { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] };
  });

  return server;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const replyDelayMs = Number(process.env.TWICESHY_SLOW_REPLY_MS ?? '800');
  await createProgressServer({
    replyDelayMs,
    ...(process.env.TWICESHY_SLOW_START_FILE === undefined
      ? {}
      : { startFile: process.env.TWICESHY_SLOW_START_FILE }),
  }).connect(new StdioServerTransport());
}
