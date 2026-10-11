import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

/**
 * A server that asks its client for sampling and elicitation. The proxy must
 * refuse both with UNSUPPORTED_FEATURE, so the tools return the refusal text.
 */
export function createInteractiveServer() {
  const server = new Server(
    { name: 'interactive', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler('tools/list', async () => ({
    tools: [
      {
        name: 'ask_sampling',
        description: 'Asks the client to sample from an LLM',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'ask_elicitation',
        description: 'Asks the client for user input',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }));

  server.setRequestHandler('tools/call', async (request) => {
    if (request.params.name === 'ask_sampling') {
      try {
        const result = await server.createMessage({
          messages: [{ role: 'user', content: { type: 'text', text: 'Say hello' } }],
          maxTokens: 16,
        });
        return { content: [{ type: 'text', text: `sampling answered ${JSON.stringify(result)}` }] };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: String(error?.message ?? error) }],
        };
      }
    }
    if (request.params.name === 'ask_elicitation') {
      try {
        const result = await server.elicitInput({
          message: 'Please provide a value',
          requestedSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          },
        });
        return {
          content: [{ type: 'text', text: `elicitation answered ${JSON.stringify(result)}` }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: String(error?.message ?? error) }],
        };
      }
    }
    return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
  });

  return server;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createInteractiveServer().connect(new StdioServerTransport());
}
