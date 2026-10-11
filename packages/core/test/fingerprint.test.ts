import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { FingerprintOptions } from '../src/index.js';
import {
  ConfigInvalidError,
  canonicalize,
  computeFingerprint,
  NotSerializableError,
  selectFields,
} from '../src/index.js';
import goldenFingerprints from './golden-fingerprints.json';

const SERVER = 'local';
const TOOL = 'test.tool';

function fingerprintOf(args: Record<string, unknown>, options?: FingerprintOptions): string {
  return computeFingerprint({ serverId: SERVER, toolName: TOOL, args, options }).fingerprint;
}

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reverseObjectKeys);
  }
  if (value instanceof Date) {
    return value;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).reverse();
    return Object.fromEntries(entries.map(([key, child]) => [key, reverseObjectKeys(child)]));
  }
  return value;
}

const arbJsonValue = fc.letrec((tie) => ({
  value: fc.oneof(
    fc.constant(null),
    fc.boolean(),
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.string(),
    fc.date(),
    fc.bigInt(),
    fc.array(tie('value'), { maxLength: 3 }),
    fc.dictionary(fc.string(), tie('value'), { maxKeys: 3 }),
  ),
})).value;

describe('canonicalize', () => {
  it('sorts object keys at every depth and keeps array order', () => {
    expect(canonicalize({ b: { d: 2, c: 3 }, a: [1, 2] })).toBe('{"a":[1,2],"b":{"c":3,"d":2}}');
  });

  it('drops undefined values so a missing key and an undefined key are the same', () => {
    expect(canonicalize({ keep: 1, gone: undefined })).toBe(canonicalize({ keep: 1 }));
  });

  it('returns an empty string when the root value is dropped', () => {
    expect(canonicalize(undefined)).toBe('');
  });

  it('keeps array order and drops undefined elements', () => {
    expect(canonicalize([2, 1])).toBe('[2,1]');
    expect(canonicalize([1, undefined, 2])).toBe('[1,2]');
  });

  it('serialises booleans and null', () => {
    expect(canonicalize({ yes: true, no: false, nothing: null })).toBe(
      '{"no":false,"nothing":null,"yes":true}',
    );
  });

  it('serialises a Date with the documented v1 tag', () => {
    expect(canonicalize(new Date('2026-01-01T00:00:00.000Z'))).toBe(
      '{"$twiceshy.date":"2026-01-01T00:00:00.000Z"}',
    );
  });

  it('serialises a BigInt with the documented v1 tag', () => {
    expect(canonicalize(9007199254740993n)).toBe('{"$twiceshy.bigint":"9007199254740993"}');
  });

  it('rejects NaN at the root with a message that names the value', () => {
    const error = captureError(() => canonicalize(Number.NaN)) as NotSerializableError;
    expect(error).toBeInstanceOf(NotSerializableError);
    expect(error.code).toBe('NOT_SERIALIZABLE');
    expect(error.what).toContain('NaN');
  });

  it('rejects an invalid Date with NOT_SERIALIZABLE', () => {
    const error = captureError(() => canonicalize(new Date(Number.NaN))) as NotSerializableError;
    expect(error).toBeInstanceOf(NotSerializableError);
    expect(error.what).toContain('an invalid Date');
  });

  it('rejects a symbol-keyed property with NOT_SERIALIZABLE', () => {
    const value: Record<string | symbol, unknown> = {};
    value[Symbol('secret')] = 1;
    const error = captureError(() => canonicalize(value)) as NotSerializableError;
    expect(error).toBeInstanceOf(NotSerializableError);
    expect(error.what).toContain('a symbol-keyed property');
  });

  it('compares strings exactly without Unicode normalisation', () => {
    expect(canonicalize('café')).not.toBe(canonicalize('cafe\u0301'));
  });
});

describe('selectFields', () => {
  it('selects only the listed keyFields', () => {
    const { selected, missing } = selectFields({ a: 1, b: 2, c: 3 }, { keyFields: ['a', 'c'] });
    expect(selected).toEqual({ a: 1, c: 3 });
    expect(missing).toEqual([]);
  });

  it('supports dot paths and builds nested output', () => {
    const { selected } = selectFields(
      { customer: { email: 'ife@example.com', name: 'Ife' }, amount: 1500 },
      { keyFields: ['customer.email'] },
    );
    expect(selected).toEqual({ customer: { email: 'ife@example.com' } });
  });

  it('merges shared path prefixes into one object', () => {
    const { selected } = selectFields(
      { customer: { email: 'a@b.c', name: 'Ife' } },
      { keyFields: ['customer.email', 'customer.name'] },
    );
    expect(selected).toEqual({ customer: { email: 'a@b.c', name: 'Ife' } });
  });

  it('lets a later keyField overwrite an earlier prefix without touching the input', () => {
    const input = { a: { b: 1, c: 2 } };
    const { selected } = selectFields(input, { keyFields: ['a', 'a.b'] });
    expect(selected).toEqual({ a: { b: 1 } });
    expect(input).toEqual({ a: { b: 1, c: 2 } });
  });

  it('reports missing keyFields without failing', () => {
    const { selected, missing } = selectFields(
      { transaction: 'T1' },
      { keyFields: ['transaction', 'amount', 'customer.id'] },
    );
    expect(selected).toEqual({ transaction: 'T1' });
    expect(missing).toEqual(['amount', 'customer.id']);
  });

  it('treats an undefined value as missing', () => {
    const { selected, missing } = selectFields({ a: undefined }, { keyFields: ['a'] });
    expect(selected).toEqual({});
    expect(missing).toEqual(['a']);
  });

  it('reports paths that run through a primitive, null, or an array as missing', () => {
    const { missing } = selectFields(
      { number: 5, nothing: null, list: [1] },
      { keyFields: ['number.x', 'nothing.x', 'list.x'] },
    );
    expect(missing).toEqual(['number.x', 'nothing.x', 'list.x']);
  });

  it('uses all arguments when no options are given', () => {
    const { selected, missing } = selectFields({ a: 1, b: undefined });
    expect(selected).toStrictEqual({ a: 1, b: undefined });
    expect(missing).toEqual([]);
  });

  it('keyFields take precedence over ignoreFields', () => {
    const { selected } = selectFields(
      { keep: 1, drop: 2, ignored: 3 },
      { keyFields: ['keep', 'drop'], ignoreFields: ['drop'] },
    );
    expect(selected).toEqual({ keep: 1, drop: 2 });
  });

  it('ignoreFields removes top-level and nested fields', () => {
    const { selected, missing } = selectFields(
      { a: 1, secret: 'x', nested: { password: 'y', keep: 2 } },
      { ignoreFields: ['secret', 'nested.password'] },
    );
    expect(selected).toEqual({ a: 1, nested: { keep: 2 } });
    expect(missing).toEqual([]);
  });

  it('ignoreFields removes fields inside arrays', () => {
    const { selected } = selectFields(
      { items: [{ password: 'x', keep: 1 }] },
      {
        ignoreFields: ['items.password'],
      },
    );
    expect(selected).toEqual({ items: [{ keep: 1 }] });
  });

  it('ignoreFields does not mutate the input', () => {
    const input = { a: 1, nothing: null, nested: { keep: 2 } };
    const { selected } = selectFields(input, { ignoreFields: [] });
    expect(selected).not.toBe(input);
    expect((selected as { nested: unknown }).nested).not.toBe(input.nested);
  });

  it('ignoreFields tolerates dates and circular references', () => {
    const when = new Date('2026-01-01T00:00:00.000Z');
    const args: Record<string, unknown> = { when };
    args.circular = args;
    const { selected } = selectFields(args, { ignoreFields: ['nothing'] });
    expect((selected as { when: unknown }).when).toBe(when);
    expect(captureError(() => canonicalize(selected))).toBeInstanceOf(NotSerializableError);
  });
});

describe('normalisers', () => {
  function withAmount(amount: unknown): string {
    return fingerprintOf({ amount }, { normalize: { amount: 'number' } });
  }

  it('F4: number normaliser turns "1500", 1500, and 1500.0 into one fingerprint', () => {
    const expected = withAmount(1500);
    expect(withAmount('1500')).toBe(expected);
    expect(withAmount(1500.0)).toBe(expected);
  });

  it.each(['1,500', 'abc', '', '  ', '1e5', '0x10', '1'.padEnd(400, '0')])(
    'F4: number normaliser rejects %j',
    (value) => {
      const error = captureError(() => withAmount(value));
      expect(error).toBeInstanceOf(ConfigInvalidError);
      const configError = error as ConfigInvalidError;
      expect(configError.code).toBe('CONFIG_INVALID');
      expect(configError.what).toContain('amount');
      expect(configError.what).toContain(JSON.stringify(value));
    },
  );

  it('F4: number normaliser rejects NaN and Infinity numbers naming the field and value', () => {
    const nanError = captureError(() => withAmount(Number.NaN)) as ConfigInvalidError;
    expect(nanError).toBeInstanceOf(ConfigInvalidError);
    expect(nanError.what).toContain('amount');
    expect(nanError.what).toContain('NaN');
    const infinityError = captureError(() =>
      withAmount(Number.POSITIVE_INFINITY),
    ) as ConfigInvalidError;
    expect(infinityError.what).toContain('Infinity');
  });

  it('applies trim, lowercase, and lowercase-trim only when configured', () => {
    expect(fingerprintOf({ reason: '  refund  ' }, { normalize: { reason: 'trim' } })).toBe(
      fingerprintOf({ reason: 'refund' }),
    );
    expect(fingerprintOf({ email: 'IFE@EXAMPLE.COM' }, { normalize: { email: 'lowercase' } })).toBe(
      fingerprintOf({ email: 'ife@example.com' }),
    );
    expect(
      fingerprintOf({ email: '  IFE@Example.COM  ' }, { normalize: { email: 'lowercase-trim' } }),
    ).toBe(fingerprintOf({ email: 'ife@example.com' }));
  });

  it('leaves fields without a normaliser untouched', () => {
    expect(fingerprintOf({ amount: '1500' })).not.toBe(fingerprintOf({ amount: 1500 }));
  });

  it('normalises a dot-path field after keyFields selection', () => {
    const normalised = fingerprintOf(
      { customer: { email: 'IFE@X.COM' } },
      { keyFields: ['customer.email'], normalize: { 'customer.email': 'lowercase' } },
    );
    const expected = fingerprintOf(
      { customer: { email: 'ife@x.com' } },
      { keyFields: ['customer.email'] },
    );
    expect(normalised).toBe(expected);
  });

  it('applies a custom normaliser function', () => {
    const normalise = (value: unknown) => String(value).replace(/\s+/g, '-');
    expect(fingerprintOf({ sku: 'a  1' }, { normalize: { sku: normalise } })).toBe(
      fingerprintOf({ sku: 'a-1' }),
    );
  });

  it('skips normalisers for absent, undefined, and non-traversable paths', () => {
    expect(fingerprintOf({ a: 1 }, { normalize: { missing: 'trim' } })).toBe(
      fingerprintOf({ a: 1 }),
    );
    expect(fingerprintOf({ email: undefined }, { normalize: { email: 'lowercase' } })).toBe(
      fingerprintOf({ email: undefined }),
    );
    expect(fingerprintOf({ a: 1 }, { normalize: { 'a.b': 'trim' } })).toBe(fingerprintOf({ a: 1 }));
    expect(fingerprintOf({ a: { b: null } }, { normalize: { 'a.b.c': 'trim' } })).toBe(
      fingerprintOf({ a: { b: null } }),
    );
    expect(fingerprintOf({ a: { b: [] } }, { normalize: { 'a.b.c': 'trim' } })).toBe(
      fingerprintOf({ a: { b: [] } }),
    );
  });

  it('rejects trim on a non-string, naming the field and value', () => {
    const numberError = captureError(() =>
      fingerprintOf({ reason: 42 }, { normalize: { reason: 'trim' } }),
    ) as ConfigInvalidError;
    expect(numberError).toBeInstanceOf(ConfigInvalidError);
    expect(numberError.what).toContain('reason');
    expect(numberError.what).toContain('42');

    const booleanError = captureError(() =>
      fingerprintOf({ flag: true }, { normalize: { flag: 'trim' } }),
    ) as ConfigInvalidError;
    expect(booleanError.what).toContain('boolean');
  });

  it('rejects an unknown normaliser name', () => {
    const error = captureError(() =>
      fingerprintOf({ amount: 1 }, { normalize: { amount: 'uppercase' as 'trim' } }),
    ) as ConfigInvalidError;
    expect(error).toBeInstanceOf(ConfigInvalidError);
    expect(error.what).toContain('uppercase');
  });
});

describe('computeFingerprint', () => {
  it('F5: a Date and the matching ISO string give different fingerprints', () => {
    const iso = '2026-01-01T00:00:00.000Z';
    expect(fingerprintOf({ when: iso })).not.toBe(fingerprintOf({ when: new Date(iso) }));
  });

  it('F6: NaN throws NOT_SERIALIZABLE naming the field path', () => {
    const args = { items: [{ price: 2 }, { price: Number.NaN }] };
    const error = captureError(() => fingerprintOf(args)) as NotSerializableError;
    expect(error).toBeInstanceOf(NotSerializableError);
    expect(error.code).toBe('NOT_SERIALIZABLE');
    expect(error.what).toContain('args.items[1].price');
  });

  it('F6: Infinity and -Infinity throw NOT_SERIALIZABLE naming the field path', () => {
    const positive = captureError(() =>
      fingerprintOf({ amount: Number.POSITIVE_INFINITY }),
    ) as NotSerializableError;
    expect(positive).toBeInstanceOf(NotSerializableError);
    expect(positive.what).toContain('args.amount');

    const negative = captureError(() =>
      fingerprintOf({ amount: Number.NEGATIVE_INFINITY }),
    ) as NotSerializableError;
    expect(negative.what).toContain('args.amount');
  });

  it('F6: a function throws NOT_SERIALIZABLE naming the field path', () => {
    const error = captureError(() => fingerprintOf({ callback: () => 1 })) as NotSerializableError;
    expect(error).toBeInstanceOf(NotSerializableError);
    expect(error.what).toContain('args.callback');
  });

  it('F6: a symbol throws NOT_SERIALIZABLE naming the field path', () => {
    const error = captureError(() => fingerprintOf({ token: Symbol('t') })) as NotSerializableError;
    expect(error).toBeInstanceOf(NotSerializableError);
    expect(error.what).toContain('args.token');
  });

  it('F6: a circular reference throws NOT_SERIALIZABLE naming the field path', () => {
    const args: Record<string, unknown> = { note: 'x' };
    args.self = args;
    const error = captureError(() => fingerprintOf(args)) as NotSerializableError;
    expect(error).toBeInstanceOf(NotSerializableError);
    expect(error.what).toContain('args.self');
  });

  it('F7: same arguments with a different tool, server, or scope give different fingerprints', () => {
    const input = {
      serverId: 'server-a',
      toolName: 'refund',
      scope: 'customer-1',
      args: { amount: 1500 },
    };
    const base = computeFingerprint(input).fingerprint;
    expect(computeFingerprint({ ...input, serverId: 'server-b' }).fingerprint).not.toBe(base);
    expect(computeFingerprint({ ...input, toolName: 'transfer' }).fingerprint).not.toBe(base);
    expect(computeFingerprint({ ...input, scope: 'customer-2' }).fingerprint).not.toBe(base);
  });

  it('F8: the Kola case gives one fingerprint when the reason text is rephrased', () => {
    const options = { keyFields: ['transaction', 'amount'] };
    const first = computeFingerprint({
      serverId: 'paystack',
      toolName: 'create_refund',
      scope: 'ife',
      args: {
        transaction: 'T123',
        amount: 1500,
        customerId: 'ife',
        reason: 'Refund for missing drink',
      },
      options,
    });
    const retry = computeFingerprint({
      serverId: 'paystack',
      toolName: 'create_refund',
      scope: 'ife',
      args: {
        transaction: 'T123',
        amount: 1500,
        customerId: 'ife',
        reason: 'Refunding the missing drink',
      },
      options,
    });
    expect(first.fingerprint).toBe(retry.fingerprint);
  });

  it('returns the missing keyFields alongside the fingerprint', () => {
    const result = computeFingerprint({
      serverId: SERVER,
      toolName: TOOL,
      args: { transaction: 'T1' },
      options: { keyFields: ['transaction', 'amount'] },
    });
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.missing).toEqual(['amount']);
  });

  it('treats an absent scope as the empty string', () => {
    const noScope = computeFingerprint({ serverId: SERVER, toolName: TOOL, args: { a: 1 } });
    const emptyScope = computeFingerprint({
      serverId: SERVER,
      toolName: TOOL,
      scope: '',
      args: { a: 1 },
    });
    expect(noScope.fingerprint).toBe(emptyScope.fingerprint);
  });

  it('separator safety: a "|" inside a part cannot collide with it acting as a separator', () => {
    const args = { a: 1 };
    const fingerprints = [
      computeFingerprint({ serverId: 'a|b', toolName: 'c', scope: 'd', args }).fingerprint,
      computeFingerprint({ serverId: 'a', toolName: 'b|c', scope: 'd', args }).fingerprint,
      computeFingerprint({ serverId: 'a', toolName: 'b', scope: 'c|d', args }).fingerprint,
      computeFingerprint({ serverId: 'a"|', toolName: 'b', scope: 'c', args }).fingerprint,
      computeFingerprint({ serverId: 'a', toolName: '"|b', scope: 'c', args }).fingerprint,
    ];
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });
});

describe('property tests', () => {
  it('F1: key order at any depth never changes the fingerprint', () => {
    fc.assert(
      fc.property(arbJsonValue, (value) => {
        const before = fingerprintOf({ payload: value });
        const after = fingerprintOf({ payload: reverseObjectKeys(value) });
        expect(after).toBe(before);
        expect(canonicalize(reverseObjectKeys(value))).toBe(canonicalize(value));
      }),
      { numRuns: 1000 },
    );
  });

  it('F2: changing any value in a selected field always changes the fingerprint', () => {
    fc.assert(
      fc.property(arbJsonValue, arbJsonValue, (first, second) => {
        fc.pre(canonicalize(first) !== canonicalize(second));
        const before = fingerprintOf({ v: first }, { keyFields: ['v'] });
        const after = fingerprintOf({ v: second }, { keyFields: ['v'] });
        expect(after).not.toBe(before);
      }),
      { numRuns: 1000 },
    );
  });

  it('F3: changing a field outside keyFields never changes the fingerprint', () => {
    fc.assert(
      fc.property(fc.string(), arbJsonValue, arbJsonValue, (selected, noiseA, noiseB) => {
        const before = fingerprintOf({ selected, noise: noiseA }, { keyFields: ['selected'] });
        const after = fingerprintOf({ selected, noise: noiseB }, { keyFields: ['selected'] });
        expect(after).toBe(before);
      }),
      { numRuns: 1000 },
    );
  });
});

interface GoldenCase {
  name: string;
  serverId: string;
  toolName: string;
  scope?: string;
  args: Record<string, unknown>;
  options?: FingerprintOptions;
  expected: string;
  expectedMissing?: string[];
}

function decodeGoldenValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(decodeGoldenValue);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.$tag === 'date' && typeof record.value === 'string') {
      return new Date(record.value);
    }
    if (record.$tag === 'bigint' && typeof record.value === 'string') {
      return BigInt(record.value);
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, child]) => [key, decodeGoldenValue(child)]),
    );
  }
  return value;
}

describe('F9 golden fingerprints', () => {
  it('F9: golden fingerprints never change', () => {
    const golden = goldenFingerprints as { cases: GoldenCase[] };
    expect(golden.cases.length).toBeGreaterThanOrEqual(15);
    for (const testCase of golden.cases) {
      const result = computeFingerprint({
        serverId: testCase.serverId,
        toolName: testCase.toolName,
        scope: testCase.scope,
        args: decodeGoldenValue(testCase.args) as Record<string, unknown>,
        options: testCase.options,
      });
      expect(result.fingerprint, `golden case: ${testCase.name}`).toBe(testCase.expected);
      if (testCase.expectedMissing !== undefined) {
        expect(result.missing, `golden case: ${testCase.name}`).toEqual(testCase.expectedMissing);
      }
    }
  });
});
