import { NotSerializableError } from './errors.js';

/** Default field names whose values are replaced before anything is stored. */
export const DEFAULT_REDACT_FIELDS: readonly string[] = [
  'password',
  'pin',
  'otp',
  'cvv',
  'cvc',
  'secret',
  'token',
  'apiKey',
  'api_key',
  'authorization',
  'card.number',
  'cardNumber',
];

const REDACTED = '[redacted]';

interface RedactionMatcher {
  fullNames: Set<string>;
  paths: string[][];
}

function buildMatcher(fields: readonly string[]): RedactionMatcher {
  const fullNames = new Set<string>();
  const paths: string[][] = [];
  for (const field of fields) {
    const segments = field.split('.').map((segment) => segment.toLowerCase());
    fullNames.add(segments.join('.'));
    paths.push(segments);
  }
  return { fullNames, paths };
}

function hasLongerPath(paths: readonly string[][], candidate: readonly string[]): boolean {
  return paths.some(
    (path) =>
      path.length > candidate.length &&
      candidate.every((segment, index) => path[index] === segment),
  );
}

function redactValue(
  value: unknown,
  prefix: readonly string[],
  path: readonly string[],
  seen: WeakSet<object>,
  matcher: RedactionMatcher,
): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    throw new NotSerializableError({ path: path.join('.') });
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        redactValue(item, prefix, [...path, String(index)], seen, matcher),
      );
    }
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const lowerKey = key.toLowerCase();
      const candidate = [...prefix, lowerKey];
      if (matcher.fullNames.has(lowerKey) || matcher.fullNames.has(candidate.join('.'))) {
        output[key] = REDACTED;
        continue;
      }
      const childPrefix = hasLongerPath(matcher.paths, candidate) ? candidate : [];
      output[key] = redactValue(
        (value as Record<string, unknown>)[key],
        childPrefix,
        [...path, key],
        seen,
        matcher,
      );
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

/**
 * Returns a deep copy of `value` with sensitive fields replaced by
 * "[redacted]". The default list from the spec is always applied; `extraFields`
 * adds caller-specific names and supports dot paths such as "card.number".
 * The input is never modified. Circular references throw NOT_SERIALIZABLE and
 * name the path where the cycle was found.
 */
export function redact(value: unknown, extraFields: readonly string[] = []): unknown {
  const matcher = buildMatcher([...DEFAULT_REDACT_FIELDS, ...extraFields]);
  return redactValue(value, [], [], new WeakSet(), matcher);
}
