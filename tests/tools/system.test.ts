import { describe, expect, it } from 'vitest';
import { testConfig } from '../helpers/config.js';
import { fakeFetch, json, networkError } from '../helpers/fetch.js';
import { connect, textOf } from '../helpers/mcp.js';

describe('system tools', () => {
  it('registers ping and system info, and every default tool is read-only', async () => {
    const { client } = await connect(fakeFetch().fetch);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['automic_ping', 'automic_system_info']));
    for (const tool of tools) expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it('automic_ping calls /ping without client prefix', async () => {
    const { fetch, calls } = fakeFetch(new Response('', { status: 200 }));
    const { client } = await connect(fetch);
    const result = await client.callTool({ name: 'automic_ping', arguments: {} });
    expect(calls[0]!.url.pathname).toBe('/ae/api/v1/ping');
    expect(JSON.parse(textOf(result))).toEqual({ reachable: true, client: 400 });
  });

  it('automic_system_info returns /{client}/system/info', async () => {
    const { fetch, calls } = fakeFetch(json({ system_identifier: 'abc' }));
    const { client } = await connect(fetch);
    const result = await client.callTool({ name: 'automic_system_info', arguments: {} });
    expect(calls[0]!.url.pathname).toBe('/ae/api/v1/400/system/info');
    expect(JSON.parse(textOf(result))).toEqual({ system_identifier: 'abc' });
  });

  it('turns failures into tool errors without leaking secrets', async () => {
    const { fetch } = fakeFetch(networkError('ECONNRESET', `boom ${testConfig.password}`));
    const { client } = await connect(fetch);
    const result = await client.callTool({ name: 'automic_ping', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Automic API network error (ECONNRESET) on GET /ae/api/v1/ping');
  });

  it('reports any exception thrown by fetch as a network error, never its message', async () => {
    const fetchImpl: typeof fetch = () => {
      throw new RangeError(`internal ${testConfig.password}`);
    };
    const { client } = await connect(fetchImpl);
    const result = await client.callTool({ name: 'automic_system_info', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Automic API network error on GET /ae/api/v1/400/system/info');
  });

  it('rejects unknown arguments', async () => {
    const { fetch, calls } = fakeFetch();
    const { client } = await connect(fetch);
    const result = await client.callTool({ name: 'automic_ping', arguments: { extra: 1 } });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
