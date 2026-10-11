import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { configSchema } from '../src/index.js';

describe('schema.json', () => {
  it('is up to date with the Zod config schema', () => {
    const committed = readFileSync(
      fileURLToPath(new URL('../schema.json', import.meta.url)),
      'utf8',
    );
    const generated = `${JSON.stringify(z.toJSONSchema(configSchema), null, 2)}\n`;
    expect(committed).toBe(generated);
  });
});
