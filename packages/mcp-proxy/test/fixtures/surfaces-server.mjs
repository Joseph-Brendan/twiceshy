import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

/**
 * Resources and prompts fixture. `add_resource`, `add_prompt`, and `grow`
 * change the lists and announce it with the matching list_changed
 * notification.
 */
export function createSurfacesServer() {
  const server = new Server(
    { name: 'surfaces', version: '1.0.0' },
    {
      capabilities: { tools: {}, resources: { listChanged: true }, prompts: { listChanged: true } },
    },
  );

  const resources = [
    {
      uri: 'note://welcome',
      name: 'welcome',
      description: 'A welcome note',
      mimeType: 'text/plain',
    },
  ];
  const resourceTemplates = [
    { uriTemplate: 'note://{id}', name: 'note', description: 'A note by id' },
  ];
  const prompts = [
    {
      name: 'greet',
      description: 'Greets someone',
      arguments: [{ name: 'who', description: 'Who to greet', required: true }],
    },
  ];

  server.setRequestHandler('tools/list', async () => ({
    tools: [
      {
        name: 'add_resource',
        description: 'Adds a resource',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'add_prompt',
        description: 'Adds a prompt',
        inputSchema: { type: 'object', properties: {} },
      },
      { name: 'grow', description: 'Adds both', inputSchema: { type: 'object', properties: {} } },
    ],
  }));

  server.setRequestHandler('resources/list', async () => ({ resources }));
  server.setRequestHandler('resources/templates/list', async () => ({
    resourceTemplates,
  }));
  server.setRequestHandler('resources/read', async (request) => ({
    contents: [
      {
        uri: request.params.uri,
        mimeType: 'text/plain',
        text: `content of ${request.params.uri}`,
      },
    ],
  }));
  server.setRequestHandler('prompts/list', async () => ({ prompts }));
  server.setRequestHandler('prompts/get', async (request) => ({
    messages: [
      {
        role: 'user',
        content: { type: 'text', text: `Hello ${String(request.params.arguments?.who ?? '')}` },
      },
    ],
  }));

  const addResource = async () => {
    if (!resources.some((resource) => resource.uri === 'note://extra')) {
      resources.push({
        uri: 'note://extra',
        name: 'extra',
        description: 'An extra note',
        mimeType: 'text/plain',
      });
    }
    await server.sendResourceListChanged();
  };
  const addPrompt = async () => {
    if (!prompts.some((prompt) => prompt.name === 'farewell')) {
      prompts.push({
        name: 'farewell',
        description: 'Says goodbye',
        arguments: [{ name: 'who', description: 'Who to bid farewell', required: true }],
      });
    }
    await server.sendPromptListChanged();
  };

  server.setRequestHandler('tools/call', async (request) => {
    if (request.params.name === 'add_resource') {
      await addResource();
      return { content: [{ type: 'text', text: 'resource added' }] };
    }
    if (request.params.name === 'add_prompt') {
      await addPrompt();
      return { content: [{ type: 'text', text: 'prompt added' }] };
    }
    if (request.params.name === 'grow') {
      await addResource();
      await addPrompt();
      return { content: [{ type: 'text', text: 'grown' }] };
    }
    return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
  });

  return server;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createSurfacesServer().connect(new StdioServerTransport());
}
