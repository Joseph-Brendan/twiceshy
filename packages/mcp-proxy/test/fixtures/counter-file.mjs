import { readFileSync, writeFileSync } from 'node:fs';

/** Shared counter file helper for the fake servers. */
export function readCounter(file) {
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

export function incrementCounter(file) {
  const next = readCounter(file) + 1;
  writeFileSync(file, String(next));
  return next;
}
