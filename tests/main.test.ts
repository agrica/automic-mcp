import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';

const env = {
  AUTOMIC_BASE_URL: 'https://automic.example.invalid:8088/ae/api/v1',
  AUTOMIC_CLIENT: '400',
  AUTOMIC_USER: 'SVC_MCP',
  AUTOMIC_DEPARTMENT: 'EXAMPLE',
  AUTOMIC_PASSWORD: 'secret-value',
};

describe('main', () => {
  it('serves a server factory and logs readiness without secrets', () => {
    const serve = vi.fn();
    const log = vi.fn();
    expect(main(env, serve, log)).toBe(0);
    const factory = serve.mock.calls[0]![0] as () => McpServer;
    expect(factory()).toBeInstanceOf(McpServer);
    expect(log).toHaveBeenCalledWith('automic-mcp ready: client 400 (read-only)');
  });

  it('announces the write scope when writes are enabled', () => {
    const log = vi.fn();
    const entry = `MCP.SANDBOX.NOOP.SCRI@sha256:${'a'.repeat(64)}`;
    main({ ...env, AUTOMIC_ENABLE_WRITE: 'true', AUTOMIC_EXECUTE_ALLOWLIST: entry }, vi.fn(), log);
    expect(log).toHaveBeenCalledWith(
      'automic-mcp ready: client 400 (write tools enabled for reviewed objects: execute 1, cancel 0, restart 0)',
    );
  });

  it('returns 1 on invalid configuration without serving', () => {
    const serve = vi.fn();
    const log = vi.fn();
    expect(main({ AUTOMIC_PASSWORD: 'secret-value' }, serve, log)).toBe(1);
    expect(serve).not.toHaveBeenCalled();
    expect(log.mock.calls[0]![0]).toMatch(/^Invalid Automic configuration/);
    expect(log.mock.calls[0]![0]).not.toContain('secret-value');
  });

  it('rethrows unexpected errors', () => {
    const serve = vi.fn(() => {
      throw new Error('boom');
    });
    expect(() => main(env, serve, vi.fn())).toThrow('boom');
  });
});
