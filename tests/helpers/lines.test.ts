import { describe, expect, it } from 'vitest';
import { LineReader } from './lines.js';

describe('LineReader', () => {
  it('parses a message split across several chunks only once it is complete', () => {
    const reader = new LineReader();
    const message = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { text: 'é'.repeat(10) } });
    expect(reader.push(message.slice(0, 10))).toEqual([]);
    expect(reader.push(message.slice(10, 25))).toEqual([]);
    expect(reader.rest).toBe(message.slice(0, 25));
    expect(reader.push(`${message.slice(25)}\n`)).toEqual([message]);
    expect(JSON.parse(message)).toMatchObject({ id: 1 });
    expect(reader.rest).toBe('');
  });

  it('returns several lines of one chunk and keeps the trailing fragment', () => {
    const reader = new LineReader();
    expect(reader.push('{"a":1}\r\n\n{"b":2}\n{"c"')).toEqual(['{"a":1}', '{"b":2}']);
    expect(reader.rest).toBe('{"c"');
    expect(reader.push(':3}\n')).toEqual(['{"c":3}']);
  });
});
