import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { AutomicClient, basicToken, seg } from '../../src/automic/client.js';
import { type AutomicApiError, ToolInputError } from '../../src/automic/errors.js';
import { ExecutionList } from '../../src/automic/schemas.js';
import { createRedactor } from '../../src/security/redact.js';
import { executionList, healthForbidden, objectNotFound } from '../fixtures/observed.js';
import { testConfig } from '../helpers/config.js';
import { fakeFetch, hugeStream, json, networkError, stallingBody } from '../helpers/fetch.js';

const token = basicToken(testConfig);
const redact = createRedactor([testConfig.password, token]);
const make = (fetchImpl: typeof fetch, overrides = {}) =>
  new AutomicClient({ ...testConfig, ...overrides }, redact, fetchImpl);
const Any = z.unknown();
const failureOf = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (err: unknown) => err as AutomicApiError,
  );

describe('seg', () => {
  it('encodes special characters and refuses ".", ".." and empty segments', () => {
    expect(seg('A B#1/2?é')).toBe('A%20B%231%2F2%3F%C3%A9');
    for (const bad of ['.', '..', '']) expect(() => seg(bad)).toThrow(ToolInputError);
    expect(seg('...')).toBe('...');
  });
});

describe('AutomicClient requests', () => {
  it('sends Basic CLIENT/USER/DEPT:password in UTF-8, refuses redirects, prefixes the client', async () => {
    const { fetch, calls } = fakeFetch(json({}));
    await make(fetch).get(`/objects/${seg('A#B')}`, Any);
    expect(token).toBe(Buffer.from('400/SVC_MCP/EXAMPLE:S3cr:et-é', 'utf8').toString('base64'));
    expect(calls[0]!.headers.get('authorization')).toBe(`Basic ${token}`);
    expect(calls[0]!.redirect).toBe('manual');
    expect(calls[0]!.url.pathname).toBe('/ae/api/v1/400/objects/A%23B');
  });

  it('joins array query values with commas and skips undefined values', async () => {
    const { fetch, calls } = fakeFetch(json({}));
    await make(fetch).get('/executions', Any, {
      status: ['1800', '1900'],
      name: undefined,
      max_results: 5,
      flag: false,
    });
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({
      status: '1800,1900',
      max_results: '5',
      flag: 'false',
    });
  });

  it('posts JSON and validates the answer at runtime', async () => {
    const { fetch, calls } = fakeFetch(json({ run_id: 42, extra: 'dropped' }));
    expect(await make(fetch).post('/executions', { a: 1 }, z.object({ run_id: z.number() }))).toEqual({ run_id: 42 });
    expect(calls[0]!.headers.get('content-type')).toBe('application/json');
    expect(calls[0]!.body).toBe('{"a":1}');
  });

  it('accepts an empty body only where allowed', async () => {
    const empty = () => new Response('', { status: 200 });
    const { fetch, calls } = fakeFetch(empty(), empty());
    await expect(make(fetch).ping()).resolves.toBeUndefined();
    expect(calls[0]!.url.pathname).toBe('/ae/api/v1/ping');
    expect(await failureOf(make(fetch).get('/system/info', Any))).toMatchObject({ kind: 'invalid_response' });
  });
});

describe('AutomicClient failures', () => {
  it('maps an Automic OutError and drops the default details text', async () => {
    const { fetch } = fakeFetch(json(objectNotFound, 404));
    const error = await failureOf(make(fetch).get('/objects/DOES.NOT.EXIST', Any));
    expect(error).toMatchObject({ kind: 'http', status: 404, code: 45212, outcomeUnknown: false });
    expect(error?.message).toBe(
      "Automic API 404 on GET /ae/api/v1/400/objects/DOES.NOT.EXIST: Object 'DOES.NOT.EXIST' not found. (code 45212)",
    );
  });

  it('keeps meaningful details', async () => {
    const { fetch } = fakeFetch(json(healthForbidden, 403));
    const error = await failureOf(make(fetch).get('/system/health', Any));
    expect(error?.message).toContain("Permission check failed. (code 9) — 'Missing privilege': Access denied");
  });

  it('summarizes a documented validation-error array', async () => {
    const { fetch } = fakeFetch(json([{ code: 45113, error: 'Given string is not a valid object', path: 'x' }], 400));
    expect((await failureOf(make(fetch).post('/executions', {}, Any)))?.message).toContain(
      'Given string is not a valid object',
    );
  });

  it('reports non-JSON error pages by status only', async () => {
    const { fetch } = fakeFetch(new Response('<html>Proxy error for user bob</html>', { status: 502 }));
    const error = await failureOf(make(fetch).get('/x', Any));
    expect(error?.message).toBe('Automic API 502 on GET /ae/api/v1/400/x: HTTP 502');
    expect(error?.outcomeUnknown).toBe(true);
  });

  it('refuses redirects without following them', async () => {
    const { fetch, calls } = fakeFetch(
      new Response(null, { status: 302, headers: { location: 'http://evil.example.invalid/' } }),
    );
    expect(await failureOf(make(fetch).get('/x', Any))).toMatchObject({ kind: 'redirect', status: 302 });
    expect(calls).toHaveLength(1);
  });

  it('rejects non-JSON and structurally invalid success bodies', async () => {
    const { fetch } = fakeFetch(new Response('hello', { status: 200 }), json({ ...executionList, data: 'oops' }));
    expect(await failureOf(make(fetch).get('/x', Any))).toMatchObject({ kind: 'invalid_response' });
    const error = await failureOf(make(fetch).get('/executions', ExecutionList));
    expect(error).toMatchObject({ kind: 'invalid_response' });
    expect(error?.message).toContain('fields: data');
  });

  it('stops reading a body larger than the limit (declared or streamed)', async () => {
    const declared = new Response('x', { status: 200, headers: { 'content-length': String(10 * 1024 * 1024) } });
    const streamed = hugeStream(200 * 1024);
    const { fetch } = fakeFetch(declared, streamed.response);
    expect(await failureOf(make(fetch).get('/x', Any))).toMatchObject({ kind: 'too_large' });
    expect(await failureOf(make(fetch).get('/x', Any))).toMatchObject({ kind: 'too_large' });
    expect(streamed.cancelled()).toBe(true);
  });

  it('times out while the body is being read', async () => {
    const { fetch } = fakeFetch(stallingBody);
    const error = await failureOf(make(fetch, { timeoutMs: 50 }).get('/x', Any));
    expect(error).toMatchObject({ kind: 'timeout', status: 200, outcomeUnknown: true });
    expect(error?.message).toContain('timeout after 50 ms');
  });

  it('separates "never reached" from "maybe processed" network failures', async () => {
    const { fetch } = fakeFetch(networkError('ECONNREFUSED'), networkError('ECONNRESET'));
    expect(await failureOf(make(fetch).get('/x', Any))).toMatchObject({ kind: 'unreachable', outcomeUnknown: false });
    expect(await failureOf(make(fetch).get('/x', Any))).toMatchObject({ kind: 'network', outcomeUnknown: true });
  });

  it('never forwards secrets from Automic or from network errors', async () => {
    const leaky = {
      error: `Login failed for 400/SVC_MCP/EXAMPLE:${testConfig.password} via https://u:p@h/x`,
      details: `Authorization: Basic ${token}`,
    };
    const { fetch } = fakeFetch(json(leaky, 401), networkError('ECONNRESET', `socket hang up ${testConfig.password}`));
    const http = await failureOf(make(fetch).get('/x', Any));
    const network = await failureOf(make(fetch).get('/x', Any));
    for (const message of [http?.message ?? '', network?.message ?? '']) {
      expect(message).not.toContain(testConfig.password);
      expect(message).not.toContain(token);
      expect(message).not.toContain('u:p@');
    }
    expect(network?.message).toBe('Automic API network error (ECONNRESET) on GET /ae/api/v1/400/x');
  });

  it('redacts before clipping: a secret across the 200-character cut leaves no prefix', async () => {
    // Clip first would keep 195 'x' + 'S3cr' (a prefix that no longer matches the known secret).
    const { fetch } = fakeFetch(json({ error: `${'x'.repeat(195)}${testConfig.password} tail` }, 400));
    const message = (await failureOf(make(fetch).get('/x', Any)))?.message ?? '';
    expect(message).not.toContain('S3cr');
    expect(message).toContain(`${'x'.repeat(195)}***`);
  });
});
