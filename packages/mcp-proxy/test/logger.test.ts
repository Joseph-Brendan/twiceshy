import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, isLogLevel } from '../src/index.js';

class MemoryStream extends Writable {
  text = '';
  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.text += chunk.toString();
    callback();
  }
}

function lines(stream: MemoryStream): Record<string, unknown>[] {
  return stream.text
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('logger (C15)', () => {
  it('writes one JSON line per entry to the given stream', () => {
    const stream = new MemoryStream();
    const logger = createLogger({
      level: 'debug',
      stream,
      now: () => new Date('2026-01-01T12:00:00.000Z'),
    });
    logger.warn('careful', { attempt: 2, error: new Error('boom') });

    expect(lines(stream)).toEqual([
      {
        level: 'warn',
        at: '2026-01-01T12:00:00.000Z',
        msg: 'careful',
        attempt: 2,
        error: { name: 'Error', message: 'boom' },
      },
    ]);
  });

  it('defaults to warn and filters lower levels out', () => {
    const stream = new MemoryStream();
    const logger = createLogger({ stream });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(lines(stream).map((line) => line.level)).toEqual(['warn', 'error']);
  });

  it('child loggers add a scope and keep the level', () => {
    const stream = new MemoryStream();
    const logger = createLogger({ level: 'info', stream });
    logger.child('paystack').info('connected');
    logger.child('paystack').child('tools').debug('hidden');
    logger.child('paystack').error('failed');

    expect(lines(stream)).toEqual([
      expect.objectContaining({ level: 'info', scope: 'paystack', msg: 'connected' }),
      expect.objectContaining({ level: 'error', scope: 'paystack', msg: 'failed' }),
    ]);
  });

  it('forwards child stderr regardless of level', () => {
    const stream = new MemoryStream();
    const logger = createLogger({ level: 'error', stream });
    logger.child('broken').stderr('fake server failed to start');

    expect(lines(stream)).toEqual([
      expect.objectContaining({
        level: 'stderr',
        scope: 'broken',
        msg: 'fake server failed to start',
      }),
    ]);
  });

  it('serializes dates, arrays, nested errors, and null safely', () => {
    const stream = new MemoryStream();
    const logger = createLogger({ level: 'debug', stream });
    logger.info('fields', {
      when: new Date('2026-01-01T00:00:00.000Z'),
      list: [1, new Date('2026-01-02T00:00:00.000Z')],
      nested: { error: new Error('deep') },
      nothing: null,
    });

    const [line] = lines(stream);
    expect(line?.when).toBe('2026-01-01T00:00:00.000Z');
    expect(line?.list).toEqual([1, '2026-01-02T00:00:00.000Z']);
    expect(line?.nested).toEqual({ error: { name: 'Error', message: 'deep' } });
    expect(line?.nothing).toBeNull();
  });

  it('isLogLevel accepts only the four documented names', () => {
    expect(isLogLevel('error')).toBe(true);
    expect(isLogLevel('warn')).toBe(true);
    expect(isLogLevel('info')).toBe(true);
    expect(isLogLevel('debug')).toBe(true);
    expect(isLogLevel('verbose')).toBe(false);
    expect(isLogLevel(undefined)).toBe(false);
  });
});
