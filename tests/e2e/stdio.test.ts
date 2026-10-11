import { expect, it } from 'vitest';
import { baseEnv, initialize, startFakeAutomic, startMcp } from './harness.js';

it('speaks MCP over stdio: initialize, list, call, clean exit, nothing else on stdout', async () => {
  const automic = await startFakeAutomic((_req, res) => {
    res.writeHead(200).end();
  });
  const mcp = startMcp(baseEnv(automic.baseUrl));
  try {
    expect(await initialize(mcp)).toMatchObject({ result: { serverInfo: { name: 'automic-mcp' } } });

    mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const list = (await mcp.waitFor(2)) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((tool) => tool.name)).toContain('automic_ping');
    expect(list.result.tools.map((tool) => tool.name)).not.toContain('automic_execute_object');

    mcp.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'automic_ping', arguments: {} } });
    const call = (await mcp.waitFor(3)) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(call.result.isError).not.toBe(true);
    expect(JSON.parse(call.result.content[0]!.text)).toEqual({ reachable: true, client: 400 });
    expect(automic.seen).toEqual(['GET /ae/api/v1/ping']);

    expect(await mcp.exit()).toBe(0);
    // Every stdout line was a complete JSON-RPC 2.0 message; nothing is left half-written; logs went to stderr.
    for (const message of mcp.messages) expect(message).toMatchObject({ jsonrpc: '2.0' });
    expect(mcp.stdoutRest()).toBe('');
    expect(mcp.stderr()).toContain('automic-mcp ready: client 400 (read-only)');
    expect(mcp.stderr()).not.toContain('e2e-secret');
  } finally {
    await mcp.dispose();
    await automic.close();
  }
});
