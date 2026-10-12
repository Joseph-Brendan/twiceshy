import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { classifyError, classifyToolResult, definiteFailure, shouldGuard } from '../src/index.js';

describe('shouldGuard', () => {
  it('C1: config guard true beats a destructive annotation', () => {
    const decision = shouldGuard({ annotations: { destructiveHint: true } }, { guard: true });
    expect(decision).toEqual({ guarded: true, reason: 'config: guard true' });
  });

  it('C1: config guard false beats a destructive annotation', () => {
    const decision = shouldGuard({ annotations: { destructiveHint: true } }, { guard: false });
    expect(decision).toEqual({ guarded: false, reason: 'config: guard false' });
  });

  it('C1: readOnlyHint true means not guarded', () => {
    const decision = shouldGuard({ annotations: { readOnlyHint: true } });
    expect(decision).toEqual({ guarded: false, reason: 'annotation: readOnlyHint' });
  });

  it('C1: readOnlyHint wins over idempotentHint', () => {
    const decision = shouldGuard({ annotations: { readOnlyHint: true, idempotentHint: true } });
    expect(decision).toEqual({ guarded: false, reason: 'annotation: readOnlyHint' });
  });

  it('C1: readOnlyHint false does not open a tool', () => {
    const decision = shouldGuard({ annotations: { readOnlyHint: false } });
    expect(decision).toEqual({
      guarded: true,
      reason: 'annotation: no read-only or idempotent hint',
    });
  });

  it('C1: idempotentHint true is trusted by default', () => {
    const decision = shouldGuard({ annotations: { idempotentHint: true } });
    expect(decision).toEqual({ guarded: false, reason: 'annotation: idempotentHint (trusted)' });
  });

  it('C1: trustIdempotentHint false makes idempotentHint guarded', () => {
    const decision = shouldGuard(
      { annotations: { idempotentHint: true } },
      { trustIdempotentHint: false },
    );
    expect(decision).toEqual({ guarded: true, reason: 'annotation: idempotentHint (not trusted)' });
  });

  it('C1: trustIdempotentHint true keeps idempotentHint trusted', () => {
    const decision = shouldGuard(
      { annotations: { idempotentHint: true } },
      { trustIdempotentHint: true },
    );
    expect(decision).toEqual({ guarded: false, reason: 'annotation: idempotentHint (trusted)' });
  });

  it('C1: destructiveHint true means guarded', () => {
    const decision = shouldGuard({ annotations: { destructiveHint: true } });
    expect(decision).toEqual({ guarded: true, reason: 'annotation: destructiveHint' });
  });

  it('C1: annotations without read-only or idempotent hints mean guarded', () => {
    expect(shouldGuard({ annotations: { openWorldHint: true } })).toEqual({
      guarded: true,
      reason: 'annotation: no read-only or idempotent hint',
    });
    expect(shouldGuard({ annotations: {} })).toEqual({
      guarded: true,
      reason: 'annotation: no read-only or idempotent hint',
    });
  });

  it('C1: no annotations means guarded by default', () => {
    expect(shouldGuard({})).toEqual({ guarded: true, reason: 'no annotation, default' });
    expect(shouldGuard({ annotations: null })).toEqual({
      guarded: true,
      reason: 'no annotation, default',
    });
  });
});

describe('classifyError', () => {
  it('C2: an error marked definiteFailure is definite', () => {
    expect(classifyError(definiteFailure(new Error('bad input'))).classification).toBe('definite');
  });

  it('C2: a Zod validation error is definite', () => {
    const parsed = z.string().safeParse(123);
    const zodError = parsed.success ? new Error('expected a ZodError') : parsed.error;
    expect(classifyError(zodError).classification).toBe('definite');
  });

  it('C2: an object named ZodError is definite even from another copy of zod', () => {
    expect(classifyError({ name: 'ZodError', issues: [] }).classification).toBe('definite');
  });

  it('C2: JSON-RPC codes -32601 and -32602 are definite', () => {
    expect(classifyError({ code: -32601 }).classification).toBe('definite');
    expect(classifyError({ code: -32602 }).classification).toBe('definite');
  });

  it('C2: a nested JSON-RPC error code is definite', () => {
    expect(classifyError({ error: { code: -32601 } }).classification).toBe('definite');
  });

  it('C2: a nested non-JSON-RPC error code or non-object is ambiguous', () => {
    expect(classifyError({ error: { code: -1 } }).classification).toBe('ambiguous');
    expect(classifyError({ error: null }).classification).toBe('ambiguous');
    expect(classifyError({ error: 'plain' }).classification).toBe('ambiguous');
  });

  it('C2: a non-definite error code is ambiguous', () => {
    expect(classifyError({ code: -32000 }).classification).toBe('ambiguous');
  });

  it('C2: every definite HTTP status is definite', () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(classifyError({ status }).classification, `status ${status}`).toBe('definite');
    }
  });

  it('C2: statusCode and response.status shapes are definite', () => {
    expect(classifyError({ statusCode: 404 }).classification).toBe('definite');
    expect(classifyError({ response: { status: 422 } }).classification).toBe('definite');
  });

  it('C2: a numeric string status is definite', () => {
    expect(classifyError({ status: '404' }).classification).toBe('definite');
  });

  it('C2: a status string must be exactly three digits and an array is not accepted', () => {
    for (const status of ['400x', 'x400', '0400', ' 404 ', '4040']) {
      expect(classifyError({ status }).classification, `status ${JSON.stringify(status)}`).toBe(
        'ambiguous',
      );
    }
    expect(classifyError({ status: [404] }).classification).toBe('ambiguous');
  });

  it('C2: a response object without a status is ambiguous', () => {
    expect(classifyError({ response: {} }).classification).toBe('ambiguous');
    expect(classifyError({ response: { statusCode: 409 } }).classification).toBe('ambiguous');
  });

  it('C2: a non-numeric status value is ambiguous', () => {
    expect(classifyError({ status: 'banana' }).classification).toBe('ambiguous');
    expect(classifyError({ status: true }).classification).toBe('ambiguous');
  });

  it('C2: HTTP 5xx and 429 are ambiguous', () => {
    expect(classifyError({ status: 500 }).classification).toBe('ambiguous');
    expect(classifyError({ statusCode: 503 }).classification).toBe('ambiguous');
    expect(classifyError({ status: 429 }).classification).toBe('ambiguous');
  });

  it('C2: connection failures and timeouts are ambiguous', () => {
    expect(classifyError(new Error('socket hang up')).classification).toBe('ambiguous');
    expect(classifyError(new Error('Request timeout after 30000ms')).classification).toBe(
      'ambiguous',
    );
    expect(classifyError({ code: 'ECONNRESET' }).classification).toBe('ambiguous');
    expect(classifyError({ code: 'EPIPE' }).classification).toBe('ambiguous');
    expect(classifyError({ code: 'ETIMEDOUT' }).classification).toBe('ambiguous');
  });

  it('C2: a custom classifier can mark errors definite', () => {
    const result = classifyError({ weird: true }, { classifier: () => 'definite' });
    expect(result.classification).toBe('definite');
    expect(result.warning).toBeUndefined();
  });

  it('C2: a custom classifier can mark errors ambiguous', () => {
    const result = classifyError({}, { classifier: () => 'ambiguous' });
    expect(result.classification).toBe('ambiguous');
    expect(result.warning).toBeUndefined();
  });

  it('C2: a custom classifier that throws falls back to ambiguous with a warning', () => {
    const result = classifyError(new Error('x'), {
      classifier: () => {
        throw new Error('classifier broke');
      },
    });
    expect(result.classification).toBe('ambiguous');
    expect(result.warning).toContain('threw');
  });

  it('C2: a custom classifier returning an invalid value falls back to ambiguous with a warning', () => {
    const result = classifyError(new Error('x'), { classifier: () => 'maybe' });
    expect(result.classification).toBe('ambiguous');
    expect(result.warning).toContain('maybe');
  });

  it('C2: an unprintable custom classifier return value still falls back without throwing', () => {
    const unprintable = {
      toString() {
        throw new Error('cannot print me');
      },
    };
    const result = classifyError(new Error('x'), { classifier: () => unprintable });
    expect(result.classification).toBe('ambiguous');
    expect(result.warning).toContain('unprintable');
  });

  it('C3: thrown strings, numbers, null, and undefined are ambiguous', () => {
    expect(classifyError('boom').classification).toBe('ambiguous');
    expect(classifyError(42).classification).toBe('ambiguous');
    expect(classifyError(null).classification).toBe('ambiguous');
    expect(classifyError(undefined).classification).toBe('ambiguous');
  });

  it('C3: thrown plain objects and functions are ambiguous', () => {
    expect(classifyError({}).classification).toBe('ambiguous');
    expect(classifyError(() => undefined).classification).toBe('ambiguous');
  });

  it('C3: a function-shaped error carrying a definite code is classified by its properties', () => {
    const thrown = Object.assign(() => undefined, { code: -32602 });
    expect(classifyError(thrown).classification).toBe('definite');
  });

  it('C3: an object whose getters throw is ambiguous and never throws', () => {
    const hostile = {
      get status() {
        throw new Error('getter boom');
      },
    };
    expect(() => classifyError(hostile)).not.toThrow();
    const result = classifyError(hostile);
    expect(result.classification).toBe('ambiguous');
    expect(result.warning).toBeUndefined();
  });

  it('C3: a Proxy that throws on any property read is ambiguous', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('proxy boom');
        },
      },
    );
    expect(classifyError(hostile).classification).toBe('ambiguous');
  });
});

describe('classifyToolResult', () => {
  it('C2: an MCP error result is ambiguous by default', () => {
    expect(classifyToolResult({ isError: true })).toBe('ambiguous');
  });

  it('C2: treatToolErrorsAsDefinite makes an MCP error result definite', () => {
    expect(classifyToolResult({ isError: true }, { treatToolErrorsAsDefinite: true })).toBe(
      'definite',
    );
  });

  it('C2: a successful result needs no classification', () => {
    expect(classifyToolResult({ isError: false })).toBeNull();
    expect(classifyToolResult({ content: [] })).toBeNull();
    expect(classifyToolResult(null)).toBeNull();
  });

  it('C3: a hostile isError getter is ambiguous and never throws', () => {
    const hostile = {
      get isError() {
        throw new Error('boom');
      },
    };
    expect(() => classifyToolResult(hostile)).not.toThrow();
    expect(classifyToolResult(hostile)).toBe('ambiguous');
  });
});
