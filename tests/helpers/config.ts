import type { AutomicConfig } from '../../src/config.js';

/** Anonymized test configuration: no real host, account or password. */
export const testConfig: AutomicConfig = {
  baseUrl: 'https://automic.example.invalid:8088/ae/api/v1',
  client: 400,
  user: 'SVC_MCP',
  department: 'EXAMPLE',
  password: 'S3cr:et-é',
  enableWrite: false,
  writeScope: { execute: [], cancel: [], restart: [] },
  timeoutMs: 1000,
  maxResponseBytes: 64 * 1024,
  reportMaxChars: 1000,
  maxOutputChars: 20_000,
};
