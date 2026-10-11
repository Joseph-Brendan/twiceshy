import { ConfigInvalidError } from './errors.js';

const UNIT_MS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

type DurationUnit = keyof typeof UNIT_MS;

function isDurationUnit(value: string): value is DurationUnit {
  return Object.hasOwn(UNIT_MS, value);
}

function parseDurationString(input: string): number | null {
  const unitText = input.endsWith('ms') ? 'ms' : input.slice(-1);
  if (!isDurationUnit(unitText)) {
    return null;
  }
  const amountText = input.slice(0, input.length - unitText.length);
  if (!/^\d+$/.test(amountText)) {
    return null;
  }
  const amount = Number(amountText);
  if (!Number.isSafeInteger(amount)) {
    return null;
  }
  return amount * UNIT_MS[unitText];
}

function invalidDuration(value: unknown): ConfigInvalidError {
  const shown = typeof value === 'string' ? JSON.stringify(value) : String(value);
  return new ConfigInvalidError({
    what: `Invalid duration: ${shown}.`,
    why: 'A duration must be a non-negative whole number of milliseconds, or a string with one of these units: ms, s, m, h, d.',
    fix: 'Use a whole number of milliseconds (for example 600000) or a duration string (for example "10m").',
  });
}

/**
 * Parses a duration from a non-negative whole number of milliseconds or a
 * string such as "500ms", "30s", "10m", "2h", or "7d". Rejects anything else
 * with a CONFIG_INVALID error that shows the bad value and a valid example.
 */
export function parseDuration(value: unknown): number {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value >= 0) {
      return value;
    }
    throw invalidDuration(value);
  }
  if (typeof value === 'string') {
    const parsed = parseDurationString(value);
    if (parsed !== null) {
      return parsed;
    }
  }
  throw invalidDuration(value);
}
