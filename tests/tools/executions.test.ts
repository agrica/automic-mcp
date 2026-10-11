import { describe, expect, it } from 'vitest';
import { AutomicApiError } from '../../src/automic/errors.js';
import {
  LIST_LIMIT_NOTE,
  mayHaveMore,
  refusesZero,
  startAtSemantics,
  totalsTrend,
  truncateTail,
} from '../../src/tools/executions.js';
import { UNTRUSTED_NOTICE } from '../../src/tools/result.js';
import { executionList, reportList, reportOnePage } from '../fixtures/observed.js';
import { testConfig } from '../helpers/config.js';
import { fakeFetch, json } from '../helpers/fetch.js';
import { connect, textOf } from '../helpers/mcp.js';
import { type ReportConvention, reportServer } from '../helpers/reports.js';

const execution = executionList.data[0]!;
const page = (n: number, content = `page ${n}\n`) => ({ page: n, content });
const pages = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => page(from + i));

describe('truncateTail', () => {
  it('keeps short text and cuts long text from the start', () => {
    expect(truncateTail('abc', 10)).toEqual({ text: 'abc', truncatedChars: 0 });
    expect(truncateTail('0123456789', 4)).toEqual({ text: '6789', truncatedChars: 6 });
  });
});

describe('mayHaveMore', () => {
  it('is true on hasmore, a full page, or a total above the items returned', () => {
    expect(mayHaveMore({ total: 2, hasmore: true, data: [1, 2] }, 50)).toBe(true);
    expect(mayHaveMore({ total: 1, hasmore: false, data: [1] }, 1)).toBe(true);
    // Observed: total=27, one item, hasmore=false.
    expect(mayHaveMore({ total: 27, hasmore: false, data: [1] }, 50)).toBe(true);
  });
  it('is false only when nothing suggests more', () => {
    expect(mayHaveMore({ total: 1, hasmore: false, data: [1] }, 50)).toBe(false);
    expect(mayHaveMore({ total: 0, hasmore: false, data: [] }, 50)).toBe(false);
  });
});

describe('totalsTrend', () => {
  it('classifies stable, growing, shrinking and inconsistent totals', () => {
    expect(totalsTrend([3])).toBe('stable');
    expect(totalsTrend([3, 3, 3])).toBe('stable');
    expect(totalsTrend([2, 3])).toBe('growing');
    expect(totalsTrend([3, 2])).toBe('shrinking');
    expect(totalsTrend([2, 3, 2])).toBe('inconsistent');
  });
});

describe('startAtSemantics', () => {
  it('reads the convention from the first page returned, never from start_at=0', () => {
    expect(startAtSemantics(4, [{ page: 5 }, { page: 6 }])).toBe('exclusive');
    expect(startAtSemantics(4, [{ page: 4 }, { page: 5 }])).toBe('inclusive');
    expect(startAtSemantics(4, [{ page: 1 }])).toBe('unknown');
    expect(startAtSemantics(0, [{ page: 1 }])).toBe('unknown');
    expect(startAtSemantics(4, [])).toBe('unknown');
  });
});

describe('automic_list_executions', () => {
  it('maps filters to the query, validates and returns a continuation', async () => {
    const { fetch, calls } = fakeFetch(json(executionList));
    const { client } = await connect(fetch);
    const result = await client.callTool({
      name: 'automic_list_executions',
      arguments: {
        name: 'APP.*',
        status: ['1800', '1900'],
        queue: ['APP.TEAM.QUEUE'],
        referenceRunId: 5614600,
        includeDeactivated: true,
        timeFrom: '2026-10-11T00:00:00Z',
        maxResults: 1,
      },
    });
    expect(calls[0]!.url.pathname).toBe('/ae/api/v1/400/executions');
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({
      name: 'APP.*',
      status: '1800,1900',
      queue: 'APP.TEAM.QUEUE',
      reference_run_id: '5614600',
      include_deactivated: 'true',
      time_frame_option: 'activation',
      time_frame_from: '2026-10-11T00:00:00Z',
      max_results: '1',
    });
    const output = JSON.parse(textOf(result));
    expect(output).toMatchObject({
      total: 27,
      hasmore: false,
      returned: 1,
      may_have_more: true,
      limit_note: LIST_LIMIT_NOTE,
    });
    expect(output).not.toHaveProperty('next_start_at_run_id');
    expect(output.executions[0]).not.toHaveProperty('priority');
    expect(output.executions[0]).toMatchObject({
      run_id: 5614648,
      status: 1800,
      status_text: 'ENDED_NOT_OK - aborted',
      reference_run_id: 0,
    });
  });

  it('finds an execution that ended and was deactivated only with includeDeactivated', async () => {
    // Fake server applying the documented default: deactivated executions are excluded unless asked.
    const ended = { ...execution, run_id: 5614700, status: 1900 };
    const answer: typeof fetch = async (input) => {
      const asked = new URL(String(input)).searchParams.get('include_deactivated') === 'true';
      return json({ total: asked ? 1 : 0, hasmore: false, data: asked ? [ended] : [] });
    };
    const { client } = await connect(answer);
    const list = async (args: Record<string, unknown>) =>
      JSON.parse(textOf(await client.callTool({ name: 'automic_list_executions', arguments: args }))).executions;
    expect(await list({ name: 'APP.*' })).toEqual([]);
    expect((await list({ name: 'APP.*', includeDeactivated: true }))[0].run_id).toBe(5614700);
  });

  it('offers no continuation cursor: startAtRunId is refused before any request', async () => {
    const { fetch, calls } = fakeFetch();
    const { client } = await connect(fetch);
    const result = await client.callTool({ name: 'automic_list_executions', arguments: { startAtRunId: 5614648 } });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('rejects malformed input before any request', async () => {
    const { fetch, calls } = fakeFetch();
    const { client } = await connect(fetch);
    for (const args of [{ timeFrom: 'yesterday' }, { status: ['ENDED_OK'] }, { maxResults: 0 }]) {
      expect((await client.callTool({ name: 'automic_list_executions', arguments: args })).isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('automic_get_execution', () => {
  it('returns one validated execution', async () => {
    const { fetch, calls } = fakeFetch(json(execution));
    const { client } = await connect(fetch);
    const result = await client.callTool({ name: 'automic_get_execution', arguments: { runId: 5614648 } });
    expect(calls[0]!.url.pathname).toBe('/ae/api/v1/400/executions/5614648');
    expect(JSON.parse(textOf(result)).run_id).toBe(5614648);
  });
});

describe('automic_list_execution_children', () => {
  it('passes relation type and limit, and flags a possibly incomplete list', async () => {
    const full = {
      total: 3,
      hasmore: false,
      data: [
        { ...execution, run_id: 10 },
        { ...execution, run_id: 11 },
      ],
    };
    const { fetch, calls } = fakeFetch(json(full));
    const { client } = await connect(fetch);
    const result = await client.callTool({
      name: 'automic_list_execution_children',
      arguments: { runId: 1, relationType: 'hierarchy', maxResults: 2 },
    });
    expect(calls[0]!.url.pathname).toBe('/ae/api/v1/400/executions/1/children');
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ relation_type: 'hierarchy', max_results: '2' });
    expect(JSON.parse(textOf(result))).toMatchObject({ returned: 2, may_have_more: true });
  });

  it('refuses a continuation cursor', async () => {
    const { fetch, calls } = fakeFetch();
    const { client } = await connect(fetch);
    const result = await client.callTool({
      name: 'automic_list_execution_children',
      arguments: { runId: 1, startAtRunId: 9 },
    });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('automic_get_execution_report', () => {
  it('lists the report types', async () => {
    const { fetch, calls } = fakeFetch(json(reportList));
    const { client } = await connect(fetch);
    const result = await client.callTool({ name: 'automic_get_execution_report', arguments: { runId: 7 } });
    expect(calls[0]!.url.pathname).toBe('/ae/api/v1/400/executions/7/reports');
    expect(JSON.parse(textOf(result))).toEqual({ run_id: 7, reports: reportList });
  });

  it('reads a one-page report and confirms there is no page 2', async () => {
    const { fetch, calls } = fakeFetch(json(reportOnePage), json(reportOnePage));
    const { client } = await connect(fetch);
    const result = await client.callTool({
      name: 'automic_get_execution_report',
      arguments: { runId: 7, type: 'REP' },
    });
    // The window asks for 2 pages more than needed: page 2 would show up under either reading of start_at.
    expect(calls.map((call) => call.url.search)).toEqual(['?start_at=0&max_results=1', '?start_at=0&max_results=3']);
    expect(JSON.parse(textOf(result, 0))).toMatchObject({
      total_pages: 1,
      totals_seen: [1, 1],
      total_trend: 'stable',
      tail_reached: true,
      complete: true,
      requests: 2,
      start_at_semantics: 'unknown',
      warnings: [],
    });
    expect(textOf(result, 1)).toBe(`${UNTRUSTED_NOTICE}\n${reportOnePage.data[0]!.content}`);
  });

  it('flags a report whose total does not count pages as unconfirmed', async () => {
    const { fetch } = fakeFetch(json(reportOnePage), json({ total: 1, data: [page(1), page(2)] }));
    const { client } = await connect(fetch);
    const result = await client.callTool({
      name: 'automic_get_execution_report',
      arguments: { runId: 7, type: 'REP' },
    });
    const meta = JSON.parse(textOf(result, 0));
    expect(meta).toMatchObject({ tail_reached: false, complete: false, total_trend: 'inconsistent' });
    expect(meta.warnings).toContain('a response lists a page beyond its own total');
  });

  it('reads the last pages of a report longer than 100 pages', async () => {
    const { fetch, calls } = fakeFetch(
      json({ total: 250, data: [page(1)] }),
      json({ total: 250, data: pages(241, 250) }),
    );
    const { client } = await connect(fetch);
    const result = await client.callTool({
      name: 'automic_get_execution_report',
      arguments: { runId: 7, type: 'REP' },
    });
    expect(calls[1]!.url.search).toBe('?start_at=240&max_results=12');
    expect(JSON.parse(textOf(result, 0))).toEqual({
      run_id: 7,
      report_type: 'REP',
      total_pages: 250,
      totals_seen: [250, 250],
      total_trend: 'stable',
      pages_received: { first: 241, last: 250, count: 10 },
      requests: 2,
      start_at_semantics: 'exclusive',
      start_at_zero: 'accepted',
      tail_reached: true,
      complete: false,
      content_chars: 'page 241\n'.length * 10,
      truncated_chars: 0,
      content_limit_chars: 1000,
      previous_end_page: 240,
      warnings: [],
    });
    expect(textOf(result, 1).endsWith('page 250\n')).toBe(true);
  });

  it('continues backwards with endPage', async () => {
    const { fetch, calls } = fakeFetch(
      json({ total: 250, data: [page(1)] }),
      json({ total: 250, data: pages(231, 242) }),
    );
    const { client } = await connect(fetch);
    const result = await client.callTool({
      name: 'automic_get_execution_report',
      arguments: { runId: 7, type: 'REP', endPage: 240 },
    });
    expect(calls[1]!.url.search).toBe('?start_at=230&max_results=12');
    const meta = JSON.parse(textOf(result, 0));
    expect(meta).toMatchObject({ tail_reached: false, previous_end_page: 230, warnings: [] });
    expect(meta.pages_received).toEqual({ first: 231, last: 240, count: 10 });
    expect(textOf(result, 1)).not.toContain('page 241');
  });

  it('bounds the content (not the metadata) to reportMaxChars, keeping the end', async () => {
    const big = [page(1, 'a'.repeat(900)), page(2, `${'b'.repeat(500)}END`)];
    const { fetch } = fakeFetch(json({ total: 2, data: [big[0]] }), json({ total: 2, data: big }));
    const { client } = await connect(fetch);
    const result = await client.callTool({
      name: 'automic_get_execution_report',
      arguments: { runId: 7, type: 'REP' },
    });
    expect(JSON.parse(textOf(result, 0))).toMatchObject({
      truncated_chars: 403,
      content_chars: 1000,
      complete: false,
      tail_reached: true,
    });
    const content = textOf(result, 1).slice(UNTRUSTED_NOTICE.length + 1);
    expect(content).toHaveLength(1000);
    expect(content.endsWith('END')).toBe(true);
  });

  it('redacts before cutting: a secret across the cut leaves no suffix, sizes are those returned', async () => {
    // 1000 kept chars: a cut on the raw text would keep the end of the password ("et-é") at the start.
    const raw = `${'a'.repeat(100)}${testConfig.password}${'b'.repeat(995)}`;
    const { fetch } = fakeFetch(json({ total: 1, data: [page(1, raw)] }), json({ total: 1, data: [page(1, raw)] }));
    const { client } = await connect(fetch);
    const result = await client.callTool({
      name: 'automic_get_execution_report',
      arguments: { runId: 7, type: 'REP' },
    });
    const meta = JSON.parse(textOf(result, 0));
    const content = textOf(result, 1).slice(UNTRUSTED_NOTICE.length + 1);
    expect(content).not.toContain('et-é');
    expect(content).toBe(`${'a'.repeat(2)}***${'b'.repeat(995)}`);
    expect(meta).toMatchObject({ content_chars: 1000, truncated_chars: 98 });
  });

  it('never reports the tail when the report grows between requests', async () => {
    // Reproduced defect: first answer total 2, then total 3 with pages 1-2.
    const { fetch } = fakeFetch(json({ total: 2, data: [page(1)] }), json({ total: 3, data: pages(1, 2) }));
    const { client } = await connect(fetch);
    const result = await client.callTool({
      name: 'automic_get_execution_report',
      arguments: { runId: 7, type: 'REP' },
    });
    const meta = JSON.parse(textOf(result, 0));
    expect(meta).toMatchObject({ totals_seen: [2, 3], total_trend: 'growing', tail_reached: false, complete: false });
    expect(meta.warnings).toContain('total changed between requests (2 -> 3): report growing while read');
  });

  it('flags a report that shrinks between requests', async () => {
    const { fetch } = fakeFetch(json({ total: 3, data: [page(1)] }), json({ total: 2, data: pages(1, 2) }));
    const { client } = await connect(fetch);
    const result = await client.callTool({
      name: 'automic_get_execution_report',
      arguments: { runId: 7, type: 'REP' },
    });
    expect(JSON.parse(textOf(result, 0))).toMatchObject({
      totals_seen: [3, 2],
      total_trend: 'shrinking',
      tail_reached: false,
      complete: false,
    });
  });

  it('flags pages numbered beyond the announced total as inconsistent', async () => {
    const { fetch } = fakeFetch(json({ total: 2, data: [page(1)] }), json({ total: 2, data: [page(1), page(3)] }));
    const { client } = await connect(fetch);
    const result = await client.callTool({
      name: 'automic_get_execution_report',
      arguments: { runId: 7, type: 'REP' },
    });
    expect(JSON.parse(textOf(result, 0))).toMatchObject({ total_trend: 'inconsistent', tail_reached: false });
  });

  it('says so when the server returns other pages than requested', async () => {
    const { fetch } = fakeFetch(json({ total: 250, data: [page(1)] }), json({ total: 250, data: pages(1, 10) }));
    const { client } = await connect(fetch);
    const result = await client.callTool({
      name: 'automic_get_execution_report',
      arguments: { runId: 7, type: 'REP' },
    });
    const meta = JSON.parse(textOf(result, 0));
    expect(meta).toMatchObject({ tail_reached: false, complete: false });
    expect(meta.warnings[0]).toContain('requested pages 241-250');
  });

  it('selects pages by number under both readings of start_at (inclusive server)', async () => {
    // Inclusive reading (older documentation): start_at=240 returns pages 240, 241, ...
    const { fetch } = fakeFetch(json({ total: 250, data: [page(1)] }), json({ total: 250, data: pages(240, 250) }));
    const { client } = await connect(fetch);
    const result = await client.callTool({
      name: 'automic_get_execution_report',
      arguments: { runId: 7, type: 'REP' },
    });
    expect(JSON.parse(textOf(result, 0))).toMatchObject({
      pages_received: { first: 241, last: 250, count: 10 },
      start_at_semantics: 'inclusive',
      tail_reached: true,
      warnings: [],
    });
    expect(textOf(result, 1)).not.toContain('page 240');
  });

  it('flags a page repeated in one response', async () => {
    const { fetch } = fakeFetch(
      json({ total: 2, data: [page(1)] }),
      json({ total: 2, data: [page(1), page(1), page(2)] }),
    );
    const { client } = await connect(fetch);
    const result = await client.callTool({
      name: 'automic_get_execution_report',
      arguments: { runId: 7, type: 'REP' },
    });
    const meta = JSON.parse(textOf(result, 0));
    expect(meta).toMatchObject({ tail_reached: false, complete: false });
    expect(meta.warnings).toContain('a response lists the same page twice');
  });

  it('handles an empty report', async () => {
    const { fetch, calls } = fakeFetch(json({ total: 0, data: [] }));
    const { client } = await connect(fetch);
    const result = await client.callTool({
      name: 'automic_get_execution_report',
      arguments: { runId: 7, type: 'LOG' },
    });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(textOf(result, 0))).toMatchObject({ total_pages: 0, tail_reached: false, complete: false });
  });
});

describe('automic_get_execution_report — the three readings of start_at (simulated servers)', () => {
  const read = async (fetchImpl: typeof fetch, args: Record<string, unknown> = {}) => {
    const { client } = await connect(fetchImpl);
    const result = await client.callTool({
      name: 'automic_get_execution_report',
      arguments: { runId: 7, type: 'REP', ...args },
    });
    return { result, meta: JSON.parse(textOf(result, 0)), body: textOf(result, 1) };
  };
  const conventions: [ReportConvention, 'accepted' | 'refused', 'exclusive' | 'inclusive'][] = [
    ['exclusive', 'accepted', 'exclusive'],
    ['inclusive', 'accepted', 'inclusive'],
    ['inclusive-refusing-zero', 'refused', 'inclusive'],
  ];

  describe.each(conventions)('%s server', (convention, zero, semantics) => {
    it('reads a one-page report: tail reached, complete, no warning', async () => {
      const server = reportServer(1, convention);
      const { meta, body } = await read(server.fetch);
      expect(meta).toMatchObject({
        total_pages: 1,
        pages_received: { first: 1, last: 1, count: 1 },
        tail_reached: true,
        complete: true,
        start_at_zero: zero,
        requests: zero === 'refused' ? 3 : 2,
        warnings: [],
      });
      expect(body.endsWith('p1\n')).toBe(true);
      // start_at=0 is never sent again once refused.
      if (zero === 'refused') expect(server.calls.filter((call) => call.includes('start_at=0'))).toHaveLength(1);
    });

    it('reads the last 10 pages of a 250-page report: 241-250', async () => {
      const { meta, body } = await read(reportServer(250, convention).fetch);
      expect(meta).toMatchObject({
        pages_received: { first: 241, last: 250, count: 10 },
        tail_reached: true,
        complete: false,
        previous_end_page: 240,
        start_at_semantics: semantics,
        warnings: [],
      });
      expect(body.startsWith(`${UNTRUSTED_NOTICE}\np241\n`)).toBe(true);
      expect(body.endsWith('p250\n')).toBe(true);
    });

    it('continues backwards with endPage: 231-240, not the tail', async () => {
      const { meta, body } = await read(reportServer(250, convention).fetch, { endPage: 240 });
      expect(meta).toMatchObject({
        pages_received: { first: 231, last: 240, count: 10 },
        tail_reached: false,
        previous_end_page: 230,
        warnings: [],
      });
      expect(body).not.toContain('p241');
    });

    it('names the convention when the window starts beyond page 1 (6 pages, endPage 6, pages 3)', async () => {
      const { meta } = await read(reportServer(6, convention).fetch, { endPage: 6, pages: 3 });
      expect(meta).toMatchObject({
        pages_received: { first: 4, last: 6, count: 3 },
        start_at_semantics: semantics,
        tail_reached: true,
      });
    });

    it('cannot name the convention when the window starts at page 1 (6 pages, default window)', async () => {
      const { meta } = await read(reportServer(6, convention).fetch);
      expect(meta.start_at_semantics).toBe(zero === 'refused' ? 'inclusive' : 'unknown');
    });
  });

  it('reads only a 400 on start_at=0 as "zero refused"', () => {
    expect(refusesZero(new AutomicApiError('http', 400, 'bad request'))).toBe(true);
    expect(refusesZero(new AutomicApiError('http', 403, 'forbidden'))).toBe(false);
    expect(refusesZero(new AutomicApiError('timeout', 0, 'timeout'))).toBe(false);
    expect(refusesZero(new Error('x'))).toBe(false);
  });

  it.each([
    ['a 403 on start_at=0', [json({ code: 9, error: 'Missing privilege' }, 403)], 1, /Automic API 403/],
    [
      'a 400 on start_at=0 then a 400 on start_at=1',
      [json({ error: 'bad' }, 400), json({ code: 45212, error: 'unknown report type' }, 400)],
      2,
      /Automic API 400/,
    ],
    [
      'a 404 on the window after start_at=0 was accepted',
      [json({ total: 3, data: [{ page: 1, content: 'p1' }] }), json({ code: 45212, error: 'gone' }, 404)],
      2,
      /Automic API 404/,
    ],
  ] as const)('does not hide other errors: %s', async (_label, replies, requests, message) => {
    const { fetch, calls } = fakeFetch(...replies);
    const { client } = await connect(fetch);
    const result = await client.callTool({
      name: 'automic_get_execution_report',
      arguments: { runId: 7, type: 'REP' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(message);
    expect(calls).toHaveLength(requests);
  });
});
