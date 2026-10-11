import { describe, expect, it } from 'vitest';
import { clip, createRedactor } from '../../src/security/redact.js';

const redact = createRedactor(['S3cr:et-é', 'NDAwL1NWQ19NQ1A=']);

describe('redactor.text — known secrets (exact, always)', () => {
  it('masks configured secrets, longest first', () => {
    expect(redact.text('pwd S3cr:et-é token NDAwL1NWQ19NQ1A=')).toBe('pwd *** token ***');
  });

  it('masks a configured secret whatever its length, even 1 or 2 characters', () => {
    expect(createRedactor(['ab']).text('xaby')).toBe('x***y');
    expect(createRedactor(['Z']).text('aZb')).toBe('a***b');
  });

  it('ignores only the empty string', () => {
    expect(createRedactor(['']).text('abc')).toBe('abc');
  });
});

describe('redactor.text — heuristics (best effort, unknown secrets)', () => {
  it('masks Basic/Bearer tokens, URL credentials and password=value pairs', () => {
    expect(redact.text('Authorization: Basic QUJDREVGR0hJSg==')).toBe('Authorization: Basic ***');
    expect(redact.text('Bearer eyJhbGciOi.payload.sig')).toBe('Bearer ***');
    expect(redact.text('see https://bob:hunter2@host/x')).toBe('see https://***@host/x');
    expect(redact.text('password=hunter2; pwd: "x y" token=abc')).toBe('password=***; pwd: *** token=***');
  });

  it('does not catch an unknown secret without a recognizable shape (documented limit)', () => {
    expect(redact.text('the code is hunter2')).toBe('the code is hunter2');
  });
});

describe('redactor.value', () => {
  it('masks secret-looking keys and VARA-like rows, and redacts nested strings', () => {
    const input = {
      general_attributes: { name: 'X' },
      login_password: 'p1',
      rows: [
        { key: 'DB_PASSWORD', value1: 'p2', value2: 'p3' },
        { key: 'HOST', value1: 'db.example.invalid' },
      ],
      script: ['echo S3cr:et-é'],
      nested: { apiKey: 42, ok: null },
    };
    expect(redact.value(input)).toEqual({
      general_attributes: { name: 'X' },
      login_password: '***',
      rows: [
        { key: 'DB_PASSWORD', value1: '***', value2: '***' },
        { key: 'HOST', value1: 'db.example.invalid' },
      ],
      script: ['echo ***'],
      nested: { apiKey: '***', ok: null },
    });
  });

  it('masks the whole subtree of a sensitive key (object or array)', () => {
    expect(redact.value({ password: { value: 'hidden-value' }, tokens: ['t1', { t: 't2' }], keep: { a: 1 } })).toEqual({
      password: '***',
      tokens: '***',
      keep: { a: 1 },
    });
  });

  it('masks a structured value of a VARA-like secret row', () => {
    expect(redact.value({ key: 'API_TOKEN', value1: { nested: 'x' } })).toEqual({ key: 'API_TOKEN', value1: '***' });
  });
});

describe('redactor.value — property names', () => {
  it('masks a known secret used as a property name (audit 3: {"hunter2":"public"})', () => {
    const r = createRedactor(['hunter2']);
    expect(r.value({ hunter2: 'public', value: 'hunter2' })).toEqual({ '***': 'public', value: '***' });
    expect(r.value({ nested: [{ 'x-hunter2': 1 }] })).toEqual({ nested: [{ 'x-***': 1 }] });
  });

  it('keeps every entry when masked names collide', () => {
    const r = createRedactor(['hunter2']);
    expect(r.value({ hunter2: 'a', '***': 'b', 'hunter2 ': 'c' })).toEqual({ '***': 'a', '***#2': 'b', '*** ': 'c' });
  });
});

describe('redactor.value — numbers', () => {
  it('masks a number whose decimal form contains a known secret (secret 1234, RunID 51234)', () => {
    const r = createRedactor(['1234']);
    expect(r.value({ run_id: 51234, other: 42, big: 912345n })).toEqual({ run_id: '***', other: 42, big: '***' });
    expect(r.leaks(JSON.stringify(r.value({ run_id: 51234 })))).toBe(false);
  });
});

describe('redactor.leaks', () => {
  it('finds a known secret in raw or JSON-escaped form, nothing else', () => {
    const r = createRedactor(['pa"ss\\word', 'hunter2']);
    expect(r.leaks(JSON.stringify({ a: 'pa"ss\\word' }))).toBe(true);
    expect(r.leaks('xhunter2x')).toBe(true);
    expect(r.leaks(JSON.stringify(r.value({ 'pa"ss\\word': 'hunter2' })))).toBe(false);
  });
});

describe('clip', () => {
  it('caps length including the ellipsis', () => {
    expect(clip('abcdef', 4)).toBe('abc…');
    expect(clip('abc', 4)).toBe('abc');
  });
});
