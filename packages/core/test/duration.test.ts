import { describe, expect, it } from 'vitest';
import { ConfigInvalidError, parseDuration } from '../src/index.js';

function expectInvalidDuration(value: unknown, shown: string): void {
  let caught: unknown;
  try {
    parseDuration(value);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConfigInvalidError);
  const error = caught as ConfigInvalidError;
  expect(error.code).toBe('CONFIG_INVALID');
  expect(error.what).toBe(`Invalid duration: ${shown}.`);
  expect(error.why).toContain('non-negative');
  expect(error.fix).toContain('600000');
  expect(error.fix).toContain('"10m"');
}

describe('parseDuration', () => {
  it('accepts zero milliseconds as a number', () => {
    expect(parseDuration(0)).toBe(0);
  });

  it('accepts a whole number of milliseconds', () => {
    expect(parseDuration(600_000)).toBe(600_000);
  });

  it('accepts the largest safe integer', () => {
    expect(parseDuration(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('parses "500ms"', () => {
    expect(parseDuration('500ms')).toBe(500);
  });

  it('parses "30s"', () => {
    expect(parseDuration('30s')).toBe(30_000);
  });

  it('parses "10m"', () => {
    expect(parseDuration('10m')).toBe(600_000);
  });

  it('parses "2h"', () => {
    expect(parseDuration('2h')).toBe(7_200_000);
  });

  it('parses "7d"', () => {
    expect(parseDuration('7d')).toBe(604_800_000);
  });

  it('parses "0ms"', () => {
    expect(parseDuration('0ms')).toBe(0);
  });

  it('rejects a negative number', () => {
    expectInvalidDuration(-1, '-1');
  });

  it('rejects a decimal number', () => {
    expectInvalidDuration(1.5, '1.5');
  });

  it('rejects NaN', () => {
    expectInvalidDuration(Number.NaN, 'NaN');
  });

  it('rejects Infinity', () => {
    expectInvalidDuration(Number.POSITIVE_INFINITY, 'Infinity');
  });

  it('rejects an unsafe integer number', () => {
    expectInvalidDuration(Number.MAX_SAFE_INTEGER + 1, '9007199254740992');
  });

  it('rejects a decimal in a string', () => {
    expectInvalidDuration('1.5s', '"1.5s"');
  });

  it('rejects a space inside the value', () => {
    expectInvalidDuration('10 m', '"10 m"');
  });

  it('rejects a leading space', () => {
    expectInvalidDuration(' 10m', '" 10m"');
  });

  it('rejects a trailing space', () => {
    expectInvalidDuration('10m ', '"10m "');
  });

  it('rejects an unknown unit', () => {
    expectInvalidDuration('10x', '"10x"');
  });

  it('rejects a string with no unit', () => {
    expectInvalidDuration('10', '"10"');
  });

  it('rejects a unit with no number', () => {
    expectInvalidDuration('s', '"s"');
  });

  it('rejects an empty string', () => {
    expectInvalidDuration('', '""');
  });

  it('rejects a string whose number is not a safe integer', () => {
    expectInvalidDuration('99999999999999999999s', '"99999999999999999999s"');
  });

  it('rejects a value that is neither a number nor a string', () => {
    expectInvalidDuration(null, 'null');
  });
});
