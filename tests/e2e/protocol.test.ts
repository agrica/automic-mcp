import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { expect, it } from 'vitest';
import { textOf } from '../helpers/mcp.js';
import { baseEnv, startFakeAutomic } from './harness.js';

const entry = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

/**
 * The built server, reached by the official SDK client over stdio, as a host would.
 * `negotiation` is the client's ClientOptions.versionNegotiation mode ('legacy' = plain initialize).
 */
async function negotiate(negotiation: 'legacy' | 'auto' | { pin: string }) {
  const automic = await startFakeAutomic((_req, res) => {
    res.writeHead(200).end();
  });
  const client = new Client({ name: 'e2e', version: '0' }, { versionNegotiation: { mode: negotiation } });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { PATH: process.env.PATH ?? '', ...baseEnv(automic.baseUrl) },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const version = client.getNegotiatedProtocolVersion();
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    const ping = await client.callTool({ name: 'automic_ping', arguments: {} });
    return { version, tools, ping, seen: automic.seen };
  } finally {
    await client.close();
    await automic.close();
  }
}

it('serves a 2025-era host (plain initialize) with protocol 2025-11-25', async () => {
  const { version, tools, ping, seen } = await negotiate('legacy');
  expect(version).toBe('2025-11-25');
  expect(tools).toContain('automic_ping');
  expect(JSON.parse(textOf(ping))).toEqual({ reachable: true, client: 400 });
  expect(seen).toEqual(['GET /ae/api/v1/ping']);
});

it('serves a host pinned to 2026-07-28 (server/discover) with the same tools and results', async () => {
  const { version, tools, ping, seen } = await negotiate({ pin: '2026-07-28' });
  expect(version).toBe('2026-07-28');
  expect(tools).toContain('automic_ping');
  expect(tools).not.toContain('automic_execute_object');
  expect(JSON.parse(textOf(ping))).toEqual({ reachable: true, client: 400 });
  expect(seen).toEqual(['GET /ae/api/v1/ping']);
});

it("negotiates 2026-07-28 with a host in 'auto' mode", async () => {
  const { version } = await negotiate('auto');
  expect(version).toBe('2026-07-28');
});
