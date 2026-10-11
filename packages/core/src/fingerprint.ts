import { createHash } from 'node:crypto';
import { ConfigInvalidError, NotSerializableError } from './errors.js';

/**
 * Fingerprint format version. Every stored fingerprint embeds this string, so
 * changing the canonical form, the tag format below, or this separator scheme
 * requires bumping the version. Old and new fingerprints can then never match
 * each other by accident, and the golden-fixture test (test/fingerprint.test.ts,
 * F9) guards the change.
 */
const FINGERPRINT_VERSION = 'v1';

/**
 * Tag format for values JSON cannot represent (part of fingerprint format v1;
 * never change without a FINGERPRINT_VERSION bump):
 *
 *   Date   -> {"$twiceshy.date":"<ISO-8601 UTC string>"}
 *             e.g. {"$twiceshy.date":"2026-01-01T00:00:00.000Z"}
 *   BigInt -> {"$twiceshy.bigint":"<decimal string>"}
 *             e.g. {"$twiceshy.bigint":"9007199254740993"}
 *
 * The object wrapper (rather than a prefixed string) means a Date or BigInt can
 * never produce the same canonical text as a plain string that happens to look
 * the same. This is why a Date and its ISO string get different fingerprints.
 */
const DATE_TAG = '$twiceshy.date';
const BIGINT_TAG = '$twiceshy.bigint';

export interface CanonicalizeOptions {
  /**
   * Label used in NOT_SERIALIZABLE error messages, for example "args" makes
   * paths read "args.items[2].price". It does not affect the output string.
   */
  path?: string;
}

/**
 * Produces the canonical JSON string defined by SPEC.md C4:
 * keys sorted at every depth, array order kept, undefined dropped, Date and
 * BigInt tagged, and NaN, Infinity, functions, symbols, and circular
 * references rejected with NOT_SERIALIZABLE.
 */
export function canonicalize(value: unknown, options: CanonicalizeOptions = {}): string {
  return serializeValue(value, options.path ?? '', new WeakSet()) ?? '';
}

function serializeValue(value: unknown, path: string, seen: WeakSet<object>): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    return serializeNumber(value, path);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'bigint') {
    return taggedString(BIGINT_TAG, value.toString());
  }
  if (typeof value === 'symbol') {
    throw notSerializable(path, 'a symbol');
  }
  if (typeof value === 'function') {
    throw notSerializable(path, 'a function');
  }
  return serializeObject(value, path, seen);
}

function serializeObject(value: object, path: string, seen: WeakSet<object>): string {
  if (seen.has(value)) {
    throw notSerializable(path, 'a circular reference');
  }
  if (value instanceof Date) {
    return serializeDate(value, path);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const parts: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const serialized = serializeValue(value[index] as unknown, `${path}[${index}]`, seen);
        if (serialized !== undefined) {
          parts.push(serialized);
        }
      }
      return `[${parts.join(',')}]`;
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw notSerializable(path, 'a symbol-keyed property');
    }
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const serialized = serializeValue(record[key], formatKeyPath(path, key), seen);
      if (serialized !== undefined) {
        parts.push(`${JSON.stringify(key)}:${serialized}`);
      }
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

function serializeNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    throw notSerializable(path, String(value));
  }
  return JSON.stringify(value);
}

function serializeDate(value: Date, path: string): string {
  if (Number.isNaN(value.getTime())) {
    throw notSerializable(path, 'an invalid Date');
  }
  return taggedString(DATE_TAG, value.toISOString());
}

function taggedString(tag: string, value: string): string {
  return `{${JSON.stringify(tag)}:${JSON.stringify(value)}}`;
}

function formatKeyPath(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

function notSerializable(path: string, reason: string): NotSerializableError {
  return new NotSerializableError({
    path,
    what:
      path === ''
        ? `The value cannot be serialized: ${reason}.`
        : `The value at "${path}" cannot be serialized: ${reason}.`,
  });
}

export interface SelectFieldsOptions {
  /** If set, only these fields (dot paths supported) are kept. */
  keyFields?: readonly string[];
  /** Used when keyFields is not set: all arguments except these fields. */
  ignoreFields?: readonly string[];
}

export interface FieldSelection {
  /** The arguments after selection. Missing keyFields are omitted. */
  selected: Record<string, unknown>;
  /** keyFields paths that were not present in the arguments. */
  missing: string[];
}

/**
 * Applies the C4 field selection: keyFields when present, otherwise all
 * arguments minus ignoreFields. Missing or undefined keyFields are absent from
 * `selected` and reported in `missing` so the guard can warn about them.
 */
export function selectFields(
  args: Readonly<Record<string, unknown>>,
  options: SelectFieldsOptions = {},
): FieldSelection {
  if (options.keyFields !== undefined) {
    return selectByKeyFields(args, options.keyFields);
  }
  return {
    selected: omitFields(args, options.ignoreFields ?? []),
    missing: [],
  };
}

function selectByKeyFields(
  args: Readonly<Record<string, unknown>>,
  keyFields: readonly string[],
): FieldSelection {
  const selected: Record<string, unknown> = {};
  const missing: string[] = [];
  const created = new WeakSet<object>();
  for (const field of keyFields) {
    const segments = field.split('.');
    const resolved = resolvePath(args, segments);
    if (!resolved.found || resolved.value === undefined) {
      missing.push(field);
      continue;
    }
    insertSelected(selected, segments, resolved.value, created);
  }
  return { selected, missing };
}

function resolvePath(
  source: Readonly<Record<string, unknown>>,
  segments: readonly string[],
): { found: boolean; value: unknown } {
  let current: unknown = source;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return { found: false, value: undefined };
    }
    if (!Object.hasOwn(current, segment)) {
      return { found: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

function insertSelected(
  target: Record<string, unknown>,
  segments: readonly string[],
  value: unknown,
  created: WeakSet<object>,
): void {
  let current = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index] as string;
    const existing = current[segment];
    if (typeof existing === 'object' && created.has(existing as object)) {
      current = existing as Record<string, unknown>;
    } else {
      const container: Record<string, unknown> = {};
      created.add(container);
      current[segment] = container;
      current = container;
    }
  }
  current[segments[segments.length - 1] as string] = value;
}

function omitFields(
  args: Readonly<Record<string, unknown>>,
  ignoreFields: readonly string[],
): Record<string, unknown> {
  return omitPaths(args, '', new Set(ignoreFields), new WeakSet()) as Record<string, unknown>;
}

function omitPaths(
  value: unknown,
  prefix: string,
  ignored: ReadonlySet<string>,
  seen: WeakSet<object>,
): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  if (value instanceof Date) {
    return value;
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => omitPaths(item, prefix, ignored, seen));
    }
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      if (ignored.has(path)) {
        continue;
      }
      output[key] = omitPaths(record[key], path, ignored, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export type NormalizerName = 'number' | 'trim' | 'lowercase' | 'lowercase-trim';
export type Normalizer = NormalizerName | ((value: unknown) => unknown);
export type NormalizerMap = Readonly<Record<string, Normalizer>>;

const DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/;

/**
 * A value rejected by a configured normaliser is a validation mismatch between
 * the caller's data and the developer's configured expectation, so Twiceshy
 * reports CONFIG_INVALID (C9: "Config or options fail validation") with the
 * field and the bad value named. NOT_SERIALIZABLE is kept for values that have
 * no canonical representation at all (NaN, Infinity, functions, symbols,
 * circular references), which is a different failure.
 */
function invalidNormalizer(field: string, value: unknown, expected: string): ConfigInvalidError {
  return new ConfigInvalidError({
    what: `The field "${field}" cannot be normalised to ${expected}: ${describeValue(value)}.`,
    why: 'The configured normaliser for this field does not accept this value.',
    fix: `Pass ${expected} in "${field}", or remove the normaliser for this field.`,
  });
}

function invalidNormalizerKind(field: string, normalizer: unknown): ConfigInvalidError {
  return new ConfigInvalidError({
    what: `Unknown normaliser ${JSON.stringify(normalizer)} for field "${field}".`,
    why: 'Only "number", "trim", "lowercase", "lowercase-trim", or a custom function are supported.',
    fix: `Use one of the supported normaliser names for "${field}", or pass a function.`,
  });
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return `a value of type ${typeof value}`;
}

function normalizeNumber(value: unknown, field: string): number {
  if (typeof value === 'number') {
    if (Number.isFinite(value)) {
      return value;
    }
    throw invalidNormalizer(field, value, 'a finite plain decimal number');
  }
  if (typeof value === 'string' && DECIMAL_PATTERN.test(value)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw invalidNormalizer(field, value, 'a plain decimal number');
}

function normalizeString(
  value: unknown,
  field: string,
  transform: (text: string) => string,
): string {
  if (typeof value !== 'string') {
    throw invalidNormalizer(field, value, 'a string');
  }
  return transform(value);
}

function runNormalizer(normalizer: Normalizer, value: unknown, field: string): unknown {
  if (typeof normalizer === 'function') {
    return normalizer(value);
  }
  switch (normalizer) {
    case 'number':
      return normalizeNumber(value, field);
    case 'trim':
      return normalizeString(value, field, (text) => text.trim());
    case 'lowercase':
      return normalizeString(value, field, (text) => text.toLowerCase());
    case 'lowercase-trim':
      return normalizeString(value, field, (text) => text.trim().toLowerCase());
    default:
      throw invalidNormalizerKind(field, normalizer);
  }
}

function applyNormalizers(
  selected: Record<string, unknown>,
  normalize: NormalizerMap | undefined,
): Record<string, unknown> {
  if (normalize === undefined) {
    return selected;
  }
  for (const [field, normalizer] of Object.entries(normalize)) {
    applyNormalizerAtPath(selected, field.split('.'), field, normalizer);
  }
  return selected;
}

function applyNormalizerAtPath(
  target: Record<string, unknown>,
  segments: readonly string[],
  field: string,
  normalizer: Normalizer,
): void {
  let current: Record<string, unknown> = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index] as string;
    const next = current[segment];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      return;
    }
    current = next as Record<string, unknown>;
  }
  const last = segments[segments.length - 1] as string;
  if (!Object.hasOwn(current, last) || current[last] === undefined) {
    return;
  }
  current[last] = runNormalizer(normalizer, current[last], field);
}

export interface FingerprintOptions {
  keyFields?: readonly string[];
  ignoreFields?: readonly string[];
  normalize?: NormalizerMap;
}

export interface ComputeFingerprintInput {
  /** Downstream server name in the proxy, or the library namespace ("local"). */
  serverId: string;
  toolName: string;
  /** Who the action belongs to. Empty string when not set. */
  scope?: string;
  args: Readonly<Record<string, unknown>>;
  options?: FingerprintOptions;
}

export interface FingerprintResult {
  /** SHA-256 hex digest of the versioned, encoded payload. */
  fingerprint: string;
  /** keyFields listed by the developer but absent from the arguments. */
  missing: string[];
}

/**
 * Computes the C4 fingerprint:
 *
 *   "v1" | serverId | toolName | scope | canonical(selectedArgs)
 *
 * Each part is JSON-encoded before joining, which makes "|" safe: after
 * JSON quoting, the first four part boundaries are unambiguous (a "|" stays
 * inside its quotes), and the canonical JSON is the final part. Crafting a
 * serverId of "a|b" cannot impersonate serverId "a" with toolName "b|c".
 */
export function computeFingerprint(input: ComputeFingerprintInput): FingerprintResult {
  const { selected, missing } = selectFields(input.args, input.options);
  const normalized = applyNormalizers(selected, input.options?.normalize);
  const canonical = canonicalize(normalized, { path: 'args' });
  const payload = [
    FINGERPRINT_VERSION,
    input.serverId,
    input.toolName,
    input.scope ?? '',
    canonical,
  ]
    .map((part) => JSON.stringify(part))
    .join('|');
  const fingerprint = createHash('sha256').update(payload, 'utf8').digest('hex');
  return { fingerprint, missing };
}
