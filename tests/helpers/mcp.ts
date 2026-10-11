import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { onTestFinished } from 'vitest';
import type { AutomicConfig } from '../../src/config.js';
import { createServer } from '../../src/server.js';
import { testConfig } from './config.js';

/** Real MCP client <-> fresh server over an in-memory transport; closed automatically after the test. `log` replaces the captured log. */
export async function connect(
  fetchImpl: typeof fetch,
  overrides: Partial<AutomicConfig> = {},
  log?: (line: string) => void,
): Promise<{ client: Client; logs: string[] }> {
  const logs: string[] = [];
  const server = createServer(
    { ...testConfig, ...overrides },
    { fetch: fetchImpl, log: log ?? ((line) => logs.push(line)) },
  );
  return { client: await connectServer(server), logs };
}

/** Real MCP client <-> a given server over an in-memory transport; closed automatically after the test. */
export async function connectServer(server: McpServer): Promise<Client> {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  onTestFinished(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

/** Text of the content block at `index` of a tool result. */
export function textOf(result: unknown, index = 0): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  return content?.[index]?.text ?? '';
}
