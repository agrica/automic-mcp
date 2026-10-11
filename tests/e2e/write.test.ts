import { setTimeout as sleep } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { objectFingerprint } from '../../src/tools/objects.js';
import { baseEnv, initialize, startFakeAutomic, startMcp } from './harness.js';

const TIMEOUT_MS = 1_000;
const NOOP = 'MCP.SANDBOX.NOOP.SCRI';
/** The reviewed definition: the fake Automic exports it, the allowlist pins its fingerprint. */
const definition = {
  data: { scri: { general_attributes: { type: 'SCRI', name: NOOP }, scripts: [{ process: ':PRINT 1' }] } },
};

/**
 * The fake server ACCEPTS the mutation (reads the whole POST) then never answers in time, or cuts the
 * connection. The POSTs are counted server-side: the audit lines are not used as evidence of "no retry".
 */
it.each([
  ['delays its answer past the timeout', 'delay'],
  ['cuts the connection after reading the request', 'destroy'],
] as const)('reports OUTCOME UNKNOWN once when Automic %s, and sends exactly one POST', async (_label, mode) => {
  const pending: Array<() => void> = [];
  const automic = await startFakeAutomic((req, res) => {
    if (req.method === 'GET' && req.url === `/ae/api/v1/400/objects/${NOOP}`) {
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(definition));
    }
    if (req.method !== 'POST') return void res.writeHead(404).end();
    if (mode === 'destroy') return void req.socket.destroy();
    // Answer long after the client timeout (or never, if the server closes first).
    const timer = setTimeout(
      () => res.writeHead(200, { 'content-type': 'application/json' }).end('{"run_id":1}'),
      3 * TIMEOUT_MS,
    );
    pending.push(() => clearTimeout(timer));
  });
  const mcp = startMcp({
    ...baseEnv(automic.baseUrl),
    AUTOMIC_ENABLE_WRITE: 'true',
    AUTOMIC_EXECUTE_ALLOWLIST: `${NOOP}@${objectFingerprint(definition.data)}`,
    AUTOMIC_TIMEOUT_MS: String(TIMEOUT_MS),
  });
  try {
    await initialize(mcp);
    mcp.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'automic_execute_object', arguments: { name: NOOP } },
    });
    const call = (await mcp.waitFor(2)) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(call.result.isError).toBe(true);
    expect(call.result.content[0]!.text).toMatch(/^OUTCOME UNKNOWN: .*Do not retry automatically\./);

    // Wait past another full timeout: a hidden retry would show up as a second POST.
    await sleep(2 * TIMEOUT_MS);
    expect(automic.seen.filter((line) => line.startsWith('POST '))).toEqual(['POST /ae/api/v1/400/executions']);
    expect(mcp.stderr()).not.toContain('e2e-secret');
  } finally {
    for (const cancel of pending) cancel();
    await mcp.dispose();
    await automic.close();
  }
});
