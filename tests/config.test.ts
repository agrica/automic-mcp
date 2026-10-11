import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const base = {
  AUTOMIC_BASE_URL: 'https://automic.example.invalid:8088/ae/api/v1/',
  AUTOMIC_CLIENT: '400',
  AUTOMIC_USER: 'SVC_MCP',
  AUTOMIC_DEPARTMENT: 'EXAMPLE',
  AUTOMIC_PASSWORD: ' pass with spaces ',
};

const problemsOf = (env: Record<string, string | undefined>): string => {
  try {
    loadConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as Error).message;
  }
  throw new Error('expected a ConfigError');
};

describe('loadConfig', () => {
  it('parses a valid environment, applies defaults and keeps the password verbatim', () => {
    expect(loadConfig(base)).toEqual({
      baseUrl: 'https://automic.example.invalid:8088/ae/api/v1',
      client: 400,
      user: 'SVC_MCP',
      department: 'EXAMPLE',
      password: ' pass with spaces ',
      enableWrite: false,
      writeScope: { execute: [], cancel: [], restart: [] },
      timeoutMs: 30_000,
      maxResponseBytes: 5 * 1024 * 1024,
      reportMaxChars: 20_000,
      maxOutputChars: 100_000,
    });
  });

  it('refuses http:// unless explicitly allowed', () => {
    const http = { ...base, AUTOMIC_BASE_URL: 'http://automic.example.invalid:8088/ae/api/v1' };
    expect(problemsOf(http)).toContain('AUTOMIC_ALLOW_INSECURE_HTTP=true');
    expect(loadConfig({ ...http, AUTOMIC_ALLOW_INSECURE_HTTP: 'true' }).baseUrl).toBe(http.AUTOMIC_BASE_URL);
  });

  it.each([
    ['credentials', 'https://user:pw@automic.example.invalid/ae/api/v1', 'must not contain credentials'],
    ['query', 'https://automic.example.invalid/ae/api/v1?x=1', 'must not contain a query or fragment'],
    ['empty query', 'https://automic.example.invalid/ae/api/v1?', 'must not contain a query or fragment'],
    ['fragment', 'https://automic.example.invalid/ae/api/v1#top', 'must not contain a query or fragment'],
    ['other scheme', 'ftp://automic.example.invalid/ae', 'must use https://'],
    ['garbage', 'not a url', 'is not a valid URL'],
  ])('rejects a base URL with %s', (_label, url, message) => {
    const problems = problemsOf({ ...base, AUTOMIC_BASE_URL: url });
    expect(problems).toContain(message);
    expect(problems).not.toContain('pw@');
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['missing', undefined],
  ])('never turns a %s client into client 0', (_label, value) => {
    expect(problemsOf({ ...base, AUTOMIC_CLIENT: value })).toContain('AUTOMIC_CLIENT is required');
  });

  it.each(['0', '0000', '10000', '4OO', '-1', '1e3'])('rejects client "%s"', (value) => {
    expect(problemsOf({ ...base, AUTOMIC_CLIENT: value })).toMatch(/AUTOMIC_CLIENT (0|must)/);
  });

  it('rejects "/" and ":" in user and department (they delimit the Basic user name)', () => {
    const problems = problemsOf({ ...base, AUTOMIC_USER: 'A/B', AUTOMIC_DEPARTMENT: 'X:Y' });
    expect(problems).toContain('AUTOMIC_USER must not contain');
    expect(problems).toContain('AUTOMIC_DEPARTMENT must not contain');
  });

  it('rejects ambiguous booleans instead of guessing', () => {
    expect(problemsOf({ ...base, AUTOMIC_ENABLE_WRITE: 'yes' })).toContain(
      'AUTOMIC_ENABLE_WRITE must be "true" or "false"',
    );
    expect(loadConfig({ ...base, AUTOMIC_ENABLE_WRITE: 'FALSE' }).enableWrite).toBe(false);
  });

  it('requires at least one reviewed object to enable writes, one list per action', () => {
    expect(problemsOf({ ...base, AUTOMIC_ENABLE_WRITE: 'true' })).toContain(
      'AUTOMIC_ENABLE_WRITE=true requires at least one reviewed object',
    );
    const pin = `sha256:${'a'.repeat(64)}`;
    const config = loadConfig({
      ...base,
      AUTOMIC_ENABLE_WRITE: 'true',
      AUTOMIC_EXECUTE_ALLOWLIST: ` mcp.sandbox.noop.scri@${pin} , MCP.SANDBOX.SLEEP.SCRI@${pin} `,
      AUTOMIC_CANCEL_ALLOWLIST: `MCP.SANDBOX.SLEEP.SCRI@${pin}`,
    });
    expect(config.writeScope).toEqual({
      execute: [
        { name: 'MCP.SANDBOX.NOOP.SCRI', fingerprint: pin },
        { name: 'MCP.SANDBOX.SLEEP.SCRI', fingerprint: pin },
      ],
      cancel: [{ name: 'MCP.SANDBOX.SLEEP.SCRI', fingerprint: pin }],
      restart: [],
    });
  });

  it.each([
    ['a wildcard', `MCP.SANDBOX.*@sha256:${'a'.repeat(64)}`],
    ['no fingerprint', 'MCP.SANDBOX.NOOP.SCRI'],
    ['a short fingerprint', 'MCP.SANDBOX.NOOP.SCRI@sha256:abc'],
    ['an upper-case fingerprint', `MCP.SANDBOX.NOOP.SCRI@sha256:${'A'.repeat(64)}`],
  ])('refuses a reviewed-object entry with %s', (_label, entry) => {
    expect(problemsOf({ ...base, AUTOMIC_RESTART_ALLOWLIST: entry })).toContain(
      'AUTOMIC_RESTART_ALLOWLIST must list NAME@sha256:<64 lowercase hex> entries',
    );
  });

  it('refuses the former pattern allowlist instead of ignoring it', () => {
    expect(problemsOf({ ...base, AUTOMIC_WRITE_ALLOWLIST: 'MCP.SANDBOX.*' })).toContain(
      'AUTOMIC_WRITE_ALLOWLIST is no longer supported',
    );
  });

  it('validates numeric limits', () => {
    expect(problemsOf({ ...base, AUTOMIC_TIMEOUT_MS: '10' })).toContain(
      'AUTOMIC_TIMEOUT_MS must be an integer between 1000',
    );
    expect(problemsOf({ ...base, AUTOMIC_MAX_RESPONSE_BYTES: '12kb' })).toContain('AUTOMIC_MAX_RESPONSE_BYTES');
    expect(loadConfig({ ...base, AUTOMIC_REPORT_MAX_CHARS: '5000' }).reportMaxChars).toBe(5000);
  });

  it('keeps the report content limit inside the MCP output budget', () => {
    expect(problemsOf({ ...base, AUTOMIC_MAX_OUTPUT_CHARS: '20000' })).toContain(
      'AUTOMIC_REPORT_MAX_CHARS must be at most AUTOMIC_MAX_OUTPUT_CHARS - 5000',
    );
    const ok = loadConfig({ ...base, AUTOMIC_MAX_OUTPUT_CHARS: '25000' });
    expect(ok).toMatchObject({ reportMaxChars: 20_000, maxOutputChars: 25_000 });
  });

  it('lists every problem at once and never echoes the password', () => {
    const problems = problemsOf({ AUTOMIC_PASSWORD: 'topsecret', AUTOMIC_CLIENT: 'x' });
    expect(problems).toContain('AUTOMIC_BASE_URL is required');
    expect(problems).toContain('AUTOMIC_USER is required');
    expect(problems).not.toContain('topsecret');
  });
});
