import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { LineReader } from '../helpers/lines.js';

const entry = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

/** Rejects after `ms`: every wait of the e2e tests is bounded. */
export function bounded<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms: ${what}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface FakeAutomic {
  baseUrl: string;
  /** Requests seen by the server, counted server-side ("METHOD /path"). */
  seen: string[];
  close(): Promise<void>;
}

/** Local fake of the AE REST API on loopback. The handler gets the request with its body fully read. */
export async function startFakeAutomic(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<FakeAutomic> {
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push(`${req.method} ${req.url}`);
      handler(req, res, Buffer.concat(chunks).toString('utf8'));
    });
  });
  server.listen(0, '127.0.0.1');
  await bounded(once(server, 'listening'), 5_000, 'fake Automic listening');
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/ae/api/v1`,
    seen,
    async close() {
      server.closeAllConnections();
      server.close();
      await bounded(once(server, 'close'), 5_000, 'fake Automic close');
    },
  };
}

export interface McpProcess {
  child: ChildProcessWithoutNullStreams;
  /** Every complete stdout line, parsed. */
  messages: Record<string, unknown>[];
  stderr(): string;
  /** Text after the last newline of stdout (must be empty at the end). */
  stdoutRest(): string;
  send(message: object): void;
  waitFor(id: number, ms?: number): Promise<Record<string, unknown>>;
  /** Closes stdin and waits for the exit code (bounded). */
  exit(ms?: number): Promise<number | null>;
  /** Kills the process if still running and waits for its streams to close (bounded). Safe to call twice. */
  dispose(): Promise<void>;
}

export function startMcp(env: Record<string, string>): McpProcess {
  const child = spawn(process.execPath, [entry], {
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const reader = new LineReader();
  const messages: Record<string, unknown>[] = [];
  const waiters = new Map<number, (message: Record<string, unknown>) => void>();
  let stderr = '';
  const closed = once(child, 'close');
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    for (const line of reader.push(chunk)) {
      const message = JSON.parse(line) as Record<string, unknown>;
      messages.push(message);
      if (typeof message.id === 'number') waiters.get(message.id)?.(message);
    }
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });

  return {
    child,
    messages,
    stderr: () => stderr,
    stdoutRest: () => reader.rest,
    send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    waitFor(id, ms = 10_000) {
      const already = messages.find((message) => message.id === id);
      if (already) return Promise.resolve(already);
      const arrived = new Promise<Record<string, unknown>>((resolve) => waiters.set(id, resolve));
      return bounded(arrived, ms, `response ${id}; stderr=${stderr}`);
    },
    async exit(ms = 10_000) {
      child.stdin.end();
      const [code] = (await bounded(closed, ms, 'MCP server exit')) as [number | null];
      return code;
    },
    async dispose() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await bounded(closed, 5_000, 'MCP server streams closed');
    },
  };
}

/** initialize + initialized, as an MCP host does. */
export async function initialize(mcp: McpProcess): Promise<Record<string, unknown>> {
  mcp.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } },
  });
  const response = await mcp.waitFor(1);
  mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return response;
}

export const baseEnv = (baseUrl: string): Record<string, string> => ({
  AUTOMIC_BASE_URL: baseUrl,
  AUTOMIC_ALLOW_INSECURE_HTTP: 'true',
  AUTOMIC_CLIENT: '400',
  AUTOMIC_USER: 'SVC_MCP',
  AUTOMIC_DEPARTMENT: 'EXAMPLE',
  AUTOMIC_PASSWORD: 'e2e-secret',
});
