import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REDACT_FIELDS,
  NotSerializableError,
  redact,
  TwiceshyError,
} from '../src/index.js';

const REDACTED = '[redacted]';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

describe('redact', () => {
  it('redacts every default sensitive field name at the top level', () => {
    const input: Record<string, unknown> = {};
    for (const field of DEFAULT_REDACT_FIELDS) {
      input[field] = 'secret-value';
    }
    const output = redact(input) as Record<string, unknown>;
    for (const field of DEFAULT_REDACT_FIELDS) {
      expect(output[field]).toBe(REDACTED);
    }
  });

  it('redacts matching fields at any depth', () => {
    const input = {
      order: { customer: { email: 'ife@example.com', password: 'hunter2' }, note: 'keep me' },
    };
    const output = redact(input) as typeof input;
    expect(output.order.customer.password).toBe(REDACTED);
    expect(output.order.customer.email).toBe('ife@example.com');
    expect(output.order.note).toBe('keep me');
  });

  it('redacts matching fields inside arrays', () => {
    const input = { cards: [{ cardNumber: '4111111111111111' }, { label: 'personal' }] };
    const output = redact(input) as typeof input;
    expect(output.cards[0]?.cardNumber).toBe(REDACTED);
    expect(output.cards[1]?.label).toBe('personal');
  });

  it('matches field names case-insensitively and keeps the original key spelling', () => {
    const input = { PASSWORD: 'x', ApiKey: 'y', CARDNUMBER: 'z' };
    const output = redact(input) as Record<string, unknown>;
    expect(output.PASSWORD).toBe(REDACTED);
    expect(output.ApiKey).toBe(REDACTED);
    expect(output.CARDNUMBER).toBe(REDACTED);
  });

  it('follows dot paths such as card.number', () => {
    const input = { card: { number: '4111111111111111', holder: 'Ife' } };
    const output = redact(input) as typeof input;
    expect(output.card.number).toBe(REDACTED);
    expect(output.card.holder).toBe('Ife');
  });

  it('does not treat an unrelated field below a dot-path prefix as sensitive', () => {
    const input = { card: { other: { number: 'not-a-card-number' } } };
    const output = redact(input) as typeof input;
    expect(output.card.other.number).toBe('not-a-card-number');
  });

  it('redacts extra fields passed by the caller', () => {
    const input = { iban: 'NG29-TEST', password: 'x' };
    const output = redact(input, ['iban']) as Record<string, unknown>;
    expect(output.iban).toBe(REDACTED);
    expect(output.password).toBe(REDACTED);
  });

  it('leaves fields that are not on the list unchanged', () => {
    const input = { iban: 'NG29-TEST', amount: 1500 };
    const output = redact(input) as Record<string, unknown>;
    expect(output.iban).toBe('NG29-TEST');
    expect(output.amount).toBe(1500);
  });

  it('does not mutate the input object', () => {
    const input = { card: { number: '4111' }, items: [{ pin: '1234' }], note: 'keep' };
    const before = JSON.stringify(input);
    const output = redact(input) as typeof input;
    expect(JSON.stringify(input)).toBe(before);
    expect(output).not.toBe(input);
    expect(output.card).not.toBe(input.card);
    expect(output.items[0]).not.toBe(input.items[0]);
  });

  it('redacts a deeply frozen input without throwing', () => {
    const input = deepFreeze({ password: 'x', nested: { pin: '1234' } });
    const output = redact(input) as typeof input;
    expect(output.password).toBe(REDACTED);
    expect(output.nested.pin).toBe(REDACTED);
  });

  it('throws NOT_SERIALIZABLE for a circular reference and names the field path', () => {
    const input: Record<string, unknown> = { note: 'x' };
    input.self = input;
    expect(() => redact(input)).toThrowError(NotSerializableError);
    let caught: unknown;
    try {
      redact(input);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TwiceshyError);
    const error = caught as NotSerializableError;
    expect(error.code).toBe('NOT_SERIALIZABLE');
    expect(error.what).toContain('"self"');
  });

  it('throws NOT_SERIALIZABLE for a circular array and names the index', () => {
    const list: unknown[] = ['first'];
    list.push(list);
    let caught: unknown;
    try {
      redact(list);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NotSerializableError);
    expect((caught as NotSerializableError).what).toContain('"1"');
  });

  it('names the full path for a deep circular reference', () => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = { back: a };
    a.b = b;
    let caught: unknown;
    try {
      redact(a);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NotSerializableError);
    expect((caught as NotSerializableError).what).toContain('"b.back"');
  });

  it('allows the same object to appear twice when it is not circular', () => {
    const shared = { password: 'x' };
    const input = { first: shared, second: shared };
    const output = redact(input) as typeof input;
    expect(output.first.password).toBe(REDACTED);
    expect(output.second.password).toBe(REDACTED);
  });

  it('returns primitives unchanged', () => {
    expect(redact('text')).toBe('text');
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
  });

  it('copies Date values instead of sharing them', () => {
    const when = new Date('2026-01-01T00:00:00.000Z');
    const output = redact({ when }) as { when: Date };
    expect(output.when).toBeInstanceOf(Date);
    expect(output.when).not.toBe(when);
    expect(output.when.getTime()).toBe(when.getTime());
  });
});
