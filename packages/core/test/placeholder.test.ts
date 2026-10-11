import { describe, expect, it } from 'vitest';
import { isTwiceshyActive, VERSION } from '../src/index.js';

describe('core placeholder', () => {
  it('exports version and active status', () => {
    expect(VERSION).toBe('0.0.0');
    expect(isTwiceshyActive()).toBe(true);
  });
});
