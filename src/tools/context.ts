import type { AutomicClient } from '../automic/client.js';
import type { AutomicConfig } from '../config.js';
import type { Redactor } from '../security/redact.js';

export interface ToolContext {
  client: AutomicClient;
  config: AutomicConfig;
  redact: Redactor;
  /** Writes one line to stderr (never stdout: it carries the MCP protocol). */
  log: (line: string) => void;
}
