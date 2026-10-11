import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { seg } from '../automic/client.js';
import { AutomicApiError } from '../automic/errors.js';
import { Execution, ExecutionList, ReportList, ReportPages } from '../automic/schemas.js';
import type { ToolContext } from './context.js';
import { type Runner, Untrusted } from './result.js';
import { READ_ONLY } from './system.js';

export const DEFAULT_REPORT_PAGES = 10;
export const MAX_REPORT_PAGES = 50;

/**
 * No continuation cursor is offered: the order of the results and the meaning of start_at_run_id
 * ("RunID > this parameter" on a list observed sorted by descending RunID) are not verified (H4).
 */
export const LIST_LIMIT_NOTE =
  'Only the first page is returned; no continuation is offered (paging contract unverified). ' +
  'When may_have_more is true, narrow the time window or the filters.';

/** Keeps the last `maxChars` characters of the content (errors are usually at the end). */
export function truncateTail(text: string, maxChars: number): { text: string; truncatedChars: number } {
  if (text.length <= maxChars) return { text, truncatedChars: 0 };
  return { text: text.slice(-maxChars), truncatedChars: text.length - maxChars };
}

/** Any sign that the server holds more items than returned (hasmore alone was observed false with total > items). */
export function mayHaveMore(page: { total: number; hasmore: boolean; data: unknown[] }, maxResults: number): boolean {
  return page.hasmore || page.data.length >= maxResults || page.total > page.data.length;
}

export type TotalsTrend = 'stable' | 'growing' | 'shrinking' | 'inconsistent';

/** Compares the `total` announced by successive responses of one report read. */
export function totalsTrend(totals: readonly number[]): TotalsTrend {
  let up = false;
  let down = false;
  for (let i = 1; i < totals.length; i++) {
    const previous = totals[i - 1] as number;
    const current = totals[i] as number;
    if (current > previous) up = true;
    if (current < previous) down = true;
  }
  if (up && down) return 'inconsistent';
  return up ? 'growing' : down ? 'shrinking' : 'stable';
}

const runId = z.number().int().positive().describe('Execution RunID');

export function registerExecutionTools(server: McpServer, ctx: ToolContext, safe: Runner): void {
  server.registerTool(
    'automic_list_executions',
    {
      title: 'List Automic executions',
      description:
        'Lists executions (first page only). Status codes: 1800 = ENDED_NOT_OK, 1900 = ENDED_OK. ' +
        'Times are ISO-8601 UTC. referenceRunId lists the restarts of an execution. Deactivated executions ' +
        '(often short tasks that already ended) are hidden unless includeDeactivated is true. ' +
        'If may_have_more is true, narrow timeFrom/timeTo or the filters: there is no continuation token.',
      inputSchema: z
        .object({
          name: z.string().min(1).optional().describe('Object name filter'),
          status: z
            .array(z.string().regex(/^\d{4}$/))
            .optional()
            .describe('Status codes, e.g. ["1800"]'),
          type: z
            .array(z.string().regex(/^[A-Z_]{2,8}$/))
            .optional()
            .describe('Object types, e.g. ["JOBS"]'),
          agent: z.string().min(1).optional(),
          queue: z.array(z.string().min(1)).optional(),
          user: z.string().min(1).optional(),
          referenceRunId: z.number().int().positive().optional().describe('Only restarts of this original RunID'),
          includeDeactivated: z
            .boolean()
            .optional()
            .describe('Also list deactivated executions (excluded by Automic by default)'),
          timeFrameOption: z.enum(['activation', 'start', 'end', 'all']).optional(),
          timeFrom: z.iso.datetime().optional(),
          timeTo: z.iso.datetime().optional(),
          maxResults: z.number().int().min(1).max(500).default(50),
        })
        .strict(),
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      const hasTimeFrame = args.timeFrom !== undefined || args.timeTo !== undefined;
      const page = await ctx.client.get('/executions', ExecutionList, {
        name: args.name,
        status: args.status,
        type: args.type,
        agent: args.agent,
        queue: args.queue,
        user: args.user,
        reference_run_id: args.referenceRunId,
        include_deactivated: args.includeDeactivated,
        time_frame_option: args.timeFrameOption ?? (hasTimeFrame ? 'activation' : undefined),
        time_frame_from: args.timeFrom,
        time_frame_to: args.timeTo,
        max_results: args.maxResults,
      });
      return {
        total: page.total,
        hasmore: page.hasmore,
        returned: page.data.length,
        may_have_more: mayHaveMore(page, args.maxResults),
        limit_note: LIST_LIMIT_NOTE,
        executions: page.data,
      };
    }),
  );

  server.registerTool(
    'automic_get_execution',
    {
      title: 'Get Automic execution',
      description: 'Returns the details of one execution.',
      inputSchema: z.object({ runId }).strict(),
      annotations: READ_ONLY,
    },
    safe(({ runId: id }) => ctx.client.get(`/executions/${seg(id)}`, Execution)),
  );

  server.registerTool(
    'automic_list_execution_children',
    {
      title: 'List Automic execution children',
      description:
        'Lists the direct children of an execution (first page only, no continuation token). ' +
        'If may_have_more is true, the list is incomplete: raise maxResults (up to 500).',
      inputSchema: z
        .object({
          runId,
          relationType: z.enum(['activator', 'hierarchy', 'processor']).optional().describe('Default: processor'),
          maxResults: z.number().int().min(1).max(500).default(50),
        })
        .strict(),
      annotations: READ_ONLY,
    },
    safe(async ({ runId: id, relationType, maxResults }) => {
      const page = await ctx.client.get(`/executions/${seg(id)}/children`, ExecutionList, {
        relation_type: relationType,
        max_results: maxResults,
      });
      return {
        total: page.total,
        hasmore: page.hasmore,
        returned: page.data.length,
        may_have_more: mayHaveMore(page, maxResults),
        limit_note: LIST_LIMIT_NOTE,
        children: page.data,
      };
    }),
  );

  server.registerTool(
    'automic_get_execution_report',
    {
      title: 'Get Automic execution report',
      description:
        'Without type: lists the reports of an execution (ACT, REP, POST...). With type: returns the last pages ' +
        '(or the pages ending at endPage). tail_reached/complete describe the report as read during this call: ' +
        'the API gives no snapshot, a running execution can still append pages.',
      inputSchema: z
        .object({
          runId,
          type: z
            .string()
            .regex(/^[A-Z]{2,8}$/)
            .optional()
            .describe('Report type, e.g. REP, ACT, POST, LOG'),
          pages: z.number().int().min(1).max(MAX_REPORT_PAGES).default(DEFAULT_REPORT_PAGES),
          endPage: z.number().int().positive().optional().describe('Last page to read (default: last page)'),
        })
        .strict(),
      annotations: READ_ONLY,
    },
    safe(async ({ runId: id, type, pages, endPage }) => {
      const base = `/executions/${seg(id)}/reports`;
      if (type === undefined) return { run_id: id, reports: await ctx.client.get(base, ReportList) };
      return readReport(ctx, `${base}/${seg(type)}`, { runId: id, type, pages, endPage });
    }),
  );
}

interface ReportRequest {
  runId: number;
  type: string;
  pages: number;
  endPage: number | undefined;
}

export type StartAtSemantics = 'exclusive' | 'inclusive' | 'unknown';

/** What start_at meant in one answer: first page returned = start_at + 1 (exclusive) or = start_at (inclusive). */
export function startAtSemantics(startAt: number, pages: readonly { page: number }[]): StartAtSemantics {
  if (startAt < 1 || pages.length === 0) return 'unknown'; // start_at=0 gives page 1 under both readings
  const lowest = Math.min(...pages.map((page) => page.page));
  return lowest === startAt + 1 ? 'exclusive' : lowest === startAt ? 'inclusive' : 'unknown';
}

/** Whether start_at=0 was accepted, or refused with a 400 (possible on an inclusive server, H3). */
export type StartAtZero = 'accepted' | 'refused';

/** Only a 400 on the start_at=0 request is read as "zero refused"; every other failure is reported as is. */
export function refusesZero(err: unknown): boolean {
  return err instanceof AutomicApiError && err.kind === 'http' && err.status === 400;
}

/**
 * Pagination: max_results = number of pages. The meaning of start_at is contested — spec 24.4: "pages with
 * numbers > start_at" (default 1); older documentation: start_at=4&max_results=3 returns pages 4, 5, 6 (H3).
 * The read does not depend on it: the window request starts one page early and asks for two extra pages,
 * so pages first..last AND page last+1 are covered under both readings; pages are then selected by their
 * own `page` number, never by position. The observed reading is reported (start_at_semantics).
 * start_at=0 refused: the first request (start_at=0) may get a 400 on a server that counts pages from 1.
 * Only that case is handled: the head is read again with start_at=1 and the window never asks for 0
 * (start_at=1 with first=1 still covers pages 1..last+1 on such a server). A 400 on the second request,
 * and any other error on the first one (401, 403, 404, 5xx, timeout...), is reported as is.
 * Two requests (three when zero is refused, one when the report is empty), each bounded by
 * AUTOMIC_MAX_RESPONSE_BYTES. Every response's `total` is kept: a change between requests means the
 * report moved while it was read.
 *
 * tail_reached: every response announced the same total N, the pages selected are exactly the pages
 *   requested, the last one is page N and no response lists a page above N. It describes the report
 *   at the time of the last response.
 * complete: tail_reached, the first page selected is page 1 and no character was cut.
 * Neither means "final": a running execution can still append pages (check its status).
 */
async function readReport(ctx: ToolContext, path: string, request: ReportRequest): Promise<Untrusted> {
  const warnings: string[] = [];
  const responses: ReportPages[] = [];
  const read = async (startAt: number, maxResults: number) => {
    const response = await ctx.client.get(path, ReportPages, { start_at: startAt, max_results: maxResults });
    responses.push(response);
    return response;
  };
  let zero: StartAtZero = 'accepted';
  let head: ReportPages;
  try {
    head = await read(0, 1);
  } catch (err) {
    if (!refusesZero(err)) throw err;
    zero = 'refused';
    head = await read(1, 1);
  }
  const total = head.total;
  const last = Math.min(request.endPage ?? total, total);
  const first = Math.max(1, last - request.pages + 1);

  let received = head.data;
  let semantics: StartAtSemantics = 'unknown';
  if (last >= 1) {
    const startAt = zero === 'refused' ? Math.max(1, first - 1) : first - 1;
    received = (await read(startAt, last - first + 3)).data;
    semantics = startAtSemantics(startAt, received);
  }
  const byNumber = new Map(received.map((page) => [page.page, page]));
  if (byNumber.size !== received.length) warnings.push('a response lists the same page twice');
  const pages = [...byNumber.values()].filter((page) => page.page >= first && page.page <= last);

  const totals = responses.map((response) => response.total);
  const beyondTotal = responses.some((response) => response.data.some((page) => page.page > response.total));
  const trend: TotalsTrend = beyondTotal ? 'inconsistent' : totalsTrend(totals);
  if (beyondTotal) warnings.push('a response lists a page beyond its own total');
  if (totalsTrend(totals) !== 'stable') {
    warnings.push(`total changed between requests (${totals.join(' -> ')}): report ${trend} while read`);
  }
  const sorted = [...pages].sort((a, b) => a.page - b.page);
  const numbers = sorted.map((page) => page.page);
  const expected = Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => first + index);
  const exact = numbers.length === expected.length && numbers.every((number, index) => number === expected[index]);
  if (!exact) warnings.push(`requested pages ${first}-${last}, received [${numbers.slice(0, 20).join(',')}]`);

  const lastReceived = numbers.at(-1) ?? 0;
  const tailReached = total > 0 && lastReceived === total && warnings.length === 0;
  // Redact the whole content BEFORE cutting it: a cut could split a secret and leave an unmatched part.
  const redacted = ctx.redact.text(sorted.map((page) => page.content).join(''));
  const { text, truncatedChars } = truncateTail(redacted, ctx.config.reportMaxChars);
  const firstReceived = numbers[0] ?? 0;
  const meta = {
    run_id: request.runId,
    report_type: request.type,
    total_pages: total,
    totals_seen: totals,
    total_trend: trend,
    pages_received: { first: firstReceived, last: lastReceived, count: numbers.length },
    // HTTP requests made, the refused start_at=0 included.
    requests: responses.length + (zero === 'refused' ? 1 : 0),
    start_at_semantics: semantics,
    start_at_zero: zero,
    tail_reached: tailReached,
    complete: tailReached && firstReceived === 1 && truncatedChars === 0,
    content_chars: text.length,
    truncated_chars: truncatedChars,
    content_limit_chars: ctx.config.reportMaxChars,
    previous_end_page: firstReceived > 1 ? firstReceived - 1 : null,
    warnings,
  };
  return new Untrusted(meta, text, true);
}
