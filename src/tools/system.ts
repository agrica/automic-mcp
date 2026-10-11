import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { SystemInfo } from '../automic/schemas.js';
import type { ToolContext } from './context.js';
import type { Runner } from './result.js';

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

export function registerSystemTools(server: McpServer, ctx: ToolContext, safe: Runner): void {
  server.registerTool(
    'automic_ping',
    {
      title: 'Ping Automic',
      description: 'Checks that the Automic REST API process (JCP) answers. Does not validate credentials.',
      inputSchema: z.object({}).strict(),
      annotations: READ_ONLY,
    },
    safe(async () => {
      await ctx.client.ping();
      return { reachable: true, client: ctx.client.clientId };
    }),
  );

  server.registerTool(
    'automic_system_info',
    {
      title: 'Automic system info',
      description: 'Returns Automation Engine system information. Validates the configured credentials.',
      inputSchema: z.object({}).strict(),
      annotations: READ_ONLY,
    },
    safe(() => ctx.client.get('/system/info', SystemInfo)),
  );
}
