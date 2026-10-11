import { ConfigInvalidError } from 'twiceshy';
import { describe, expect, it } from 'vitest';
import { buildToolRouting, encodeNamePart, prefixToolName } from '../src/index.js';

describe('naming', () => {
  it('prefix mode produces server__tool and routes each name back', () => {
    const routing = buildToolRouting(
      [
        { name: 'paystack', tools: [{ name: 'create_refund' }, { name: 'list_transactions' }] },
        { name: 'calendar', tools: [{ name: 'list_events' }] },
      ],
      'prefix',
    );
    expect(routing.entries.map((entry) => entry.exposedName)).toEqual([
      'paystack__create_refund',
      'paystack__list_transactions',
      'calendar__list_events',
    ]);
    const route = routing.byExposedName.get('paystack__create_refund');
    expect(route?.server).toBe('paystack');
    expect(route?.toolName).toBe('create_refund');
    expect(routing.byExposedName.get('calendar__list_events')?.server).toBe('calendar');
    expect(routing.byExposedName.get('missing')).toBeUndefined();
  });

  it('encodes characters MCP tool names do not allow', () => {
    expect(prefixToolName('weird server', 'do/it:now!')).toBe(
      'weird_0020server__do_002fit_003anow_0021',
    );
    expect(encodeNamePart('plain-name_ok.1')).toBe('plain-name_ok.1');
  });

  it('escapes a literal escape-looking sequence so encodings stay distinct', () => {
    expect(encodeNamePart('_0041')).toBe('_005f0041');
    expect(encodeNamePart('A')).toBe('A');
    expect(encodeNamePart('_0041')).not.toBe(encodeNamePart('A'));
  });

  it('none mode keeps names and reports a collision as CONFIG_INVALID naming both servers', () => {
    let caught: unknown;
    try {
      buildToolRouting(
        [
          { name: 'first', tools: [{ name: 'alpha' }] },
          { name: 'second', tools: [{ name: 'alpha' }] },
        ],
        'none',
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigInvalidError);
    const error = caught as ConfigInvalidError;
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.why).toContain('alpha');
    expect(error.why).toContain('first');
    expect(error.why).toContain('second');
  });

  it('prefix mode refuses a name combination that would collide instead of routing wrongly', () => {
    let caught: unknown;
    try {
      buildToolRouting(
        [
          { name: 'a__b', tools: [{ name: 'c' }] },
          { name: 'a', tools: [{ name: 'b__c' }] },
        ],
        'prefix',
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigInvalidError);
    expect((caught as ConfigInvalidError).why).toContain('a__b__c');
  });
});
