import { join } from 'node:path';
import { demoDir, pass, runCli, writeProxyConfig } from './lib.mjs';

/**
 * Demo 5: doctor explains its decisions about a server it has never seen. The
 * official filesystem server is added to proxy.config.json, then doctor is run
 * again. The first run downloads that server with npx and can take half a
 * minute.
 */
writeProxyConfig({
  files: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', demoDir],
  },
});

const result = await runCli(['doctor', '--config', join(demoDir, 'proxy.config.json')]);
console.log(result.stdout.trim());

const filesConnected = /files\s+connected\s+\d+\s+tools/.test(result.stdout);
const match = /files\s+connected\s+(\d+)\s+tools/.exec(result.stdout);
const toolCount = match === null ? 0 : Number(match[1]);
pass(
  'Demo 5: doctor explains a real server it has never seen',
  result.code === 0 && filesConnected && toolCount > 0,
  result.code === 0
    ? `filesystem server connected with ${toolCount} tools`
    : `doctor failed: ${result.stderr.trim()}`,
);
console.log("Read doctor's GUARDED/open reasons above. That is the part to judge by hand.");
