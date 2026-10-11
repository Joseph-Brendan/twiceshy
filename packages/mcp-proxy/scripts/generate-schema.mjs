import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { configSchema } from '../dist/index.js';

/**
 * Regenerates packages/mcp-proxy/schema.json from the Zod config schema.
 * Run `pnpm schema:generate` from the package (it builds first). The freshness
 * test in test/schema.test.ts fails when the committed file is out of date.
 */
const output = `${JSON.stringify(z.toJSONSchema(configSchema), null, 2)}\n`;
writeFileSync(new URL('../schema.json', import.meta.url), output);
process.stdout.write('Wrote packages/mcp-proxy/schema.json\n');
