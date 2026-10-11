import type { McpServer } from '@modelcontextprotocol/server';
import { type AutomicConfig, ConfigError, loadConfig } from './config.js';
import { createServer, SERVER_NAME } from './server.js';

export type Serve = (factory: () => McpServer) => unknown;

/** Starts the server and returns a process exit code. Logs go to stderr: stdout carries MCP only. */
export function main(
  env: Record<string, string | undefined>,
  serve: Serve,
  log: (line: string) => void = (line) => console.error(line),
): number {
  let config: AutomicConfig;
  try {
    config = loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) {
      log(err.message);
      return 1;
    }
    throw err;
  }
  serve(() => createServer(config, { log }));
  const { execute, cancel, restart } = config.writeScope;
  const mode = config.enableWrite
    ? `write tools enabled for reviewed objects: execute ${execute.length}, cancel ${cancel.length}, restart ${restart.length}`
    : 'read-only';
  log(`${SERVER_NAME} ready: client ${config.client} (${mode})`);
  return 0;
}
