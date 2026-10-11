import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { AutomicClient } from '../../src/automic/client.js';
import type { ReviewedObject } from '../../src/config.js';
import { createRedactor, type Redactor } from '../../src/security/redact.js';
import {
  buildExecutionBody,
  buildStatusBody,
  findReviewed,
  formatAudit,
  reconcileGuide,
  registerActionTools,
  statusResponse,
  WRITE_OBJECT_TYPES,
} from '../../src/tools/actions.js';
import type { ToolContext } from '../../src/tools/context.js';
import { objectFingerprint } from '../../src/tools/objects.js';
import { APPLIED_WITHHELD_NOTE, createRunner } from '../../src/tools/result.js';
import { executionList } from '../fixtures/observed.js';
import { testConfig } from '../helpers/config.js';
import { fakeFetch, json, networkError } from '../helpers/fetch.js';
import { connect, connectServer, textOf } from '../helpers/mcp.js';

const NOOP = 'MCP.SANDBOX.NOOP.SCRI';
const SLEEP = 'MCP.SANDBOX.SLEEP.SCRI';
/** An export as Automic returns it (shape of the official examples, H7). */
const exportOf = (name: string, type = 'SCRI', script = ':PRINT "mcp noop"') => ({
  data: { [type.toLowerCase()]: { general_attributes: { type, name }, scripts: [{ process: script }] } },
});
/** The entry a reviewer writes after reading the object with automic_get_object (its `fingerprint`). */
const reviewed = (name: string, type = 'SCRI', script?: string): ReviewedObject => ({
  name,
  fingerprint: objectFingerprint(exportOf(name, type, script).data),
});
const WRITE = {
  enableWrite: true,
  writeScope: { execute: [reviewed(NOOP)], cancel: [reviewed(SLEEP)], restart: [reviewed(SLEEP)] },
};
const sandboxRun = { ...executionList.data[0]!, run_id: 42, name: SLEEP, type: 'SCRI' };
const audits = (logs: string[]) => logs.map((line) => JSON.parse(line) as Record<string, unknown>);
const phases = (logs: string[]) =>
  audits(logs).map((event) => `${event.phase}${event.outcome ? `:${event.outcome}` : ''}`);
const posts = (calls: { method: string }[]) => calls.filter((call) => call.method === 'POST');
const since = '2026-10-11T10:00:00.000Z';
const until = '2026-10-11T10:02:00.000Z';
const target = { account: 'SVC_MCP/EXAMPLE', since, until };
const window = `"includeDeactivated":true,"timeFrameOption":"activation","timeFrom":"${since}","timeTo":"${until}"`;
/** The arguments a reconciliation message suggests for automic_list_executions. */
const suggested = (text: string) => JSON.parse(/automic_list_executions (\{.*?\})\. /.exec(text)![1]!);

describe('write policy helpers', () => {
  it('finds a reviewed object by exact name only (case-insensitive, no wildcard)', () => {
    const list = [reviewed(NOOP)];
    expect(findReviewed('mcp.sandbox.noop.scri', list)?.name).toBe(NOOP);
    expect(findReviewed('MCP.SANDBOX.NOOP.SCRIX', list)).toBeUndefined();
    expect(findReviewed('MCP.SANDBOX.*', list)).toBeUndefined();
  });

  it('builds bodies like the official 24.4 examples; cancel is never recursive', () => {
    expect(buildExecutionBody({ name: 'X', inputs: { 'VAR#': '1' } })).toEqual({
      object_name: 'X',
      execution_option: 'execute',
      inputs: { 'VAR#': '1' },
    });
    expect(buildStatusBody('cancel')).toEqual({ action: 'CANCEL', cancel: { recursive: false } });
    expect(buildStatusBody('restart')).toEqual({ action: 'RESTART' });
  });

  it('restricts writes to JOBS, JOBF and SCRI as an additional filter (not a proof of no descendants)', () => {
    expect(WRITE_OBJECT_TYPES).toEqual(['JOBS', 'JOBF', 'SCRI']);
  });

  it('names the shape of a status-change answer', () => {
    expect(statusResponse(undefined)).toBe('empty_body');
    expect(statusResponse({})).toBe('empty_object');
    expect(statusResponse({ run_id: 43 })).toBe('run_id');
  });

  it('gives a distinct reconciliation procedure per action', () => {
    const launch = reconcileGuide('launch', { name: 'A"B', ...target });
    expect(launch).toContain(`automic_list_executions {"name":"A\\"B",${window}}`);
    expect(launch).toContain('Each execution listed is only a candidate');
    const cancel = reconcileGuide('cancel', { runId: 42, ...target });
    expect(cancel).toContain('automic_get_execution {"runId":42}');
    expect(cancel).toContain('does not show that this request ended it');
    const restart = reconcileGuide('restart', { runId: 42, ...target });
    expect(restart).toContain(`automic_list_executions {"referenceRunId":42,${window}}`);
    expect(restart).toContain('Each execution with reference_run_id = 42 is only a candidate');
    expect(restart).toContain('a restart by another operator');
    for (const text of [launch, cancel, restart]) {
      expect(text).toContain('The outcome stays UNKNOWN');
      expect(text).not.toMatch(/\bprov(e|es|en)\b/);
    }
  });

  it('redacts an audit event before serializing it and bounds its free text', () => {
    const redact = createRedactor(['S3cr:et-é']);
    const line = formatAudit(
      {
        tool: 't',
        phase: 'attempt',
        object: `X.S3cr:et-é.${'Y'.repeat(500)}`,
        input_keys: Array.from({ length: 30 }, (_, i) => `K${i}#`),
      },
      redact,
      400,
      new Date(since),
    );
    const event = JSON.parse(line);
    expect(line).not.toContain('S3cr');
    expect(event.object).toHaveLength(200);
    expect(event.object.startsWith('X.***.')).toBe(true);
    expect(event).toMatchObject({ ts: since, event: 'automic_write', client: 400, input_key_count: 30 });
    expect(event.input_keys).toHaveLength(20);
  });
});

describe('write tools gating', () => {
  it('are absent by default and a direct call sends no request', async () => {
    const { fetch, calls } = fakeFetch();
    const { client } = await connect(fetch);
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      'automic_get_execution',
      'automic_get_execution_report',
      'automic_get_object',
      'automic_get_object_usage',
      'automic_list_execution_children',
      'automic_list_executions',
      'automic_ping',
      'automic_search_objects',
      'automic_system_info',
    ]);
    const outcome = await client.callTool({ name: 'automic_execute_object', arguments: { name: NOOP } }).then(
      (result) => result.isError === true,
      () => true,
    );
    expect(outcome).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('are registered with write annotations when enabled', async () => {
    const { client } = await connect(fakeFetch().fetch, WRITE);
    const tools = (await client.listTools()).tools.filter((tool) => !tool.annotations?.readOnlyHint);
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'automic_change_execution_status',
      'automic_execute_object',
    ]);
    for (const tool of tools) expect(tool.annotations).toMatchObject({ destructiveHint: true, idempotentHint: false });
  });

  it('registers only the tools of the actions that have reviewed objects', async () => {
    const names = async (scope: object) => {
      const { client } = await connect(fakeFetch().fetch, {
        enableWrite: true,
        writeScope: { execute: [], cancel: [], restart: [], ...scope },
      });
      return (await client.listTools()).tools.map((tool) => tool.name).filter((name) => !name.includes('get_'));
    };
    expect(await names({ execute: [reviewed(NOOP)] })).toContain('automic_execute_object');
    expect(await names({ execute: [reviewed(NOOP)] })).not.toContain('automic_change_execution_status');
    expect(await names({ cancel: [reviewed(SLEEP)] })).not.toContain('automic_execute_object');
  });
});

describe('automic_execute_object', () => {
  it('refuses an object that is not reviewed for execute, without any request, and audits attempt + blocked', async () => {
    const { fetch, calls } = fakeFetch();
    const { client, logs } = await connect(fetch, WRITE);
    const result = await client.callTool({ name: 'automic_execute_object', arguments: { name: 'PROD.BILLING.JOBP' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      'NOT APPLIED: "PROD.BILLING.JOBP" is not a reviewed object for execute (AUTOMIC_EXECUTE_ALLOWLIST). ' +
        'No execution was requested.',
    );
    expect(calls).toHaveLength(0);
    expect(phases(logs)).toEqual(['attempt', 'blocked:blocked']);
    expect(audits(logs)[1]).toMatchObject({ object: 'PROD.BILLING.JOBP', error_kind: 'not_reviewed' });
  });

  it('never writes a configured secret to the audit, even inside a blocked object name', async () => {
    const { fetch } = fakeFetch();
    const { client, logs } = await connect(fetch, WRITE);
    const name = `PROD.${testConfig.password}.JOBP`;
    const result = await client.callTool({ name: 'automic_execute_object', arguments: { name } });
    expect(logs).toHaveLength(2);
    expect(logs.join('\n')).not.toContain(testConfig.password);
    expect(audits(logs)[1]).toMatchObject({ object: 'PROD.***.JOBP' });
    expect(textOf(result)).not.toContain(testConfig.password);
  });

  it('reads the definition, checks its fingerprint, starts the object and audits input names only', async () => {
    const { fetch, calls } = fakeFetch(json(exportOf(NOOP)), json({ run_id: 1001345 }));
    const { client, logs } = await connect(fetch, WRITE);
    const result = await client.callTool({
      name: 'automic_execute_object',
      arguments: { name: NOOP, inputs: { 'TOKEN#': 'value-not-logged' }, queue: 'MCP.QUEUE' },
    });
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      `GET /ae/api/v1/400/objects/${NOOP}`,
      'POST /ae/api/v1/400/executions',
    ]);
    expect(JSON.parse(calls[1]!.body!)).toEqual({
      object_name: NOOP,
      execution_option: 'execute',
      inputs: { 'TOKEN#': 'value-not-logged' },
      queue: 'MCP.QUEUE',
    });
    expect(JSON.parse(textOf(result))).toEqual({
      outcome: 'started',
      object: NOOP,
      run_id: 1001345,
      audit_logged: true,
    });
    expect(phases(logs)).toEqual(['attempt', 'sent', 'result:success']);
    expect(audits(logs)[2]).toMatchObject({ new_run_id: 1001345, input_keys: ['TOKEN#'] });
    expect(logs.join('\n')).not.toContain('value-not-logged');
  });

  it.each([
    [
      'a changed definition (an activation was added)',
      exportOf(NOOP, 'SCRI', ":ACTIVATE_UC_OBJECT 'MCP.OUTSIDE.X'"),
      'definition_changed',
    ],
    ['a container type, even reviewed', exportOf(NOOP, 'JOBP'), 'type_not_allowed'],
    [
      'an export that cannot be checked',
      { data: { scri: { general_attributes: { type: 'JOBS' } } } },
      'not_exportable',
    ],
  ])('refuses %s after reading it, without any POST', async (_label, answer, reason) => {
    const { fetch, calls } = fakeFetch(json(answer));
    const scope =
      reason === 'type_not_allowed' ? { execute: [reviewed(NOOP, 'JOBP')], cancel: [], restart: [] } : WRITE.writeScope;
    const { client, logs } = await connect(fetch, { enableWrite: true, writeScope: scope });
    const result = await client.callTool({ name: 'automic_execute_object', arguments: { name: NOOP } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^NOT APPLIED: .*No execution was requested\.$/);
    expect(posts(calls)).toHaveLength(0);
    expect(phases(logs)).toEqual(['attempt', 'blocked:blocked']);
    expect(audits(logs)[1]).toMatchObject({ error_kind: reason });
  });

  it('reports a failed read of the definition as NOT APPLIED: no execution was requested', async () => {
    const { fetch, calls } = fakeFetch(new Response('oops', { status: 503 }));
    const { client, logs } = await connect(fetch, WRITE);
    const result = await client.callTool({ name: 'automic_execute_object', arguments: { name: NOOP } });
    expect(textOf(result)).toMatch(/^NOT APPLIED: precheck failed\. No execution was requested\. Automic API 503/);
    expect(posts(calls)).toHaveLength(0);
    expect(phases(logs)).toEqual(['attempt', 'precheck_failed:not_sent']);
  });

  it('keeps the action result when the audit log cannot be written', async () => {
    const { fetch, calls } = fakeFetch(json(exportOf(NOOP)), json({ run_id: 7 }));
    const { client } = await connect(fetch, WRITE, () => {
      throw new Error('disk full');
    });
    const result = await client.callTool({ name: 'automic_execute_object', arguments: { name: NOOP } });
    expect(posts(calls)).toHaveLength(1);
    expect(JSON.parse(textOf(result))).toMatchObject({ outcome: 'started', run_id: 7, audit_logged: false });
  });

  it('keeps a refusal a refusal when the audit log fails, and says so', async () => {
    const { client } = await connect(fakeFetch().fetch, WRITE, () => {
      throw new Error('disk full');
    });
    const result = await client.callTool({ name: 'automic_execute_object', arguments: { name: 'PROD.X' } });
    expect(textOf(result)).toBe(
      'NOT APPLIED: "PROD.X" is not a reviewed object for execute (AUTOMIC_EXECUTE_ALLOWLIST). ' +
        'No execution was requested. [audit log could not be written]',
    );
  });

  it('reports a confirmed refusal (4xx) as NOT APPLIED', async () => {
    const { fetch } = fakeFetch(
      json(exportOf(NOOP)),
      json([{ code: 45113, error: 'Given string is not a valid object' }], 400),
    );
    const { client, logs } = await connect(fetch, WRITE);
    const result = await client.callTool({ name: 'automic_execute_object', arguments: { name: NOOP } });
    expect(textOf(result)).toMatch(/^NOT APPLIED: Automic API 400/);
    expect(audits(logs).at(-1)).toMatchObject({ phase: 'result', outcome: 'refused', http_status: 400 });
  });

  it.each([
    ['a timeout', new DOMException('timed out', 'TimeoutError')],
    ['a reset connection', networkError('ECONNRESET')],
  ])('reports OUTCOME UNKNOWN after %s and never retries', async (_label, failure) => {
    const { fetch, calls } = fakeFetch(json(exportOf(NOOP)), failure);
    const { client, logs } = await connect(fetch, WRITE);
    const result = await client.callTool({ name: 'automic_execute_object', arguments: { name: NOOP } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^OUTCOME UNKNOWN: .*Do not retry automatically\. Reconcile \(launch\)/);
    expect(textOf(result)).toContain('compare its user with SVC_MCP/EXAMPLE');
    expect(suggested(textOf(result))).toMatchObject({ includeDeactivated: true, timeFrameOption: 'activation' });
    expect(posts(calls)).toHaveLength(1);
    expect(phases(logs)).toEqual(['attempt', 'sent', 'result:unknown']);
  });

  it('treats a 2xx without a readable run id as OUTCOME UNKNOWN', async () => {
    const { fetch } = fakeFetch(json(exportOf(NOOP)), json({ unexpected: true }));
    const { client } = await connect(fetch, WRITE);
    const result = await client.callTool({ name: 'automic_execute_object', arguments: { name: NOOP } });
    expect(textOf(result)).toMatch(/^OUTCOME UNKNOWN/);
  });

  it('reports a connection refused on the mutation as NOT APPLIED', async () => {
    const { fetch } = fakeFetch(json(exportOf(NOOP)), networkError('ECONNREFUSED'));
    const { client, logs } = await connect(fetch, WRITE);
    const result = await client.callTool({ name: 'automic_execute_object', arguments: { name: NOOP } });
    expect(textOf(result)).toMatch(/^NOT APPLIED: .*unreachable \(ECONNREFUSED\)/);
    expect(audits(logs).at(-1)).toMatchObject({ outcome: 'not_sent', error_kind: 'unreachable' });
  });
});

describe('a confirmed write whose output cannot be returned', () => {
  const silent = /Nothing was sent|NOT APPLIED|no request sent|No execution was requested|retry the/i;

  it('stays a success when its RunID contains the secret (secret 1234, RunID 51234): one POST, nothing leaked', async () => {
    const { fetch, calls } = fakeFetch(json(exportOf(NOOP)), json({ run_id: 51234 }));
    const { client, logs } = await connect(fetch, { ...WRITE, password: '1234' });
    const result = await client.callTool({ name: 'automic_execute_object', arguments: { name: NOOP } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual({ outcome: 'started', object: NOOP, run_id: '***', audit_logged: true });
    expect(JSON.stringify(result)).not.toContain('1234');
    expect(textOf(result)).not.toMatch(silent);
    expect(posts(calls)).toHaveLength(1);
    expect(phases(logs)).toEqual(['attempt', 'sent', 'result:success']);
    expect(logs.join('\n')).not.toContain('1234');
  });

  it('stays a success, details withheld, when the output exceeds the budget: one POST, audit success', async () => {
    const { fetch, calls } = fakeFetch(json(exportOf(NOOP)), json({ run_id: 1001345 }));
    const { client, logs } = await connect(fetch, { ...WRITE, maxOutputChars: 60 });
    const result = await client.callTool({ name: 'automic_execute_object', arguments: { name: NOOP } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual({
      outcome: 'started',
      applied: true,
      details_withheld: 'output_budget',
      audit_logged: true,
      note: APPLIED_WITHHELD_NOTE,
    });
    expect(textOf(result)).not.toContain('1001345');
    expect(textOf(result)).not.toMatch(silent);
    expect(posts(calls)).toHaveLength(1);
    expect(phases(logs)).toEqual(['attempt', 'sent', 'result:success']);
  });

  it('keeps cancel_requested when the output of a status change exceeds the budget', async () => {
    const { fetch, calls } = fakeFetch(json(sandboxRun), json(exportOf(SLEEP)), new Response('', { status: 200 }));
    const { client, logs } = await connect(fetch, { ...WRITE, maxOutputChars: 60 });
    const result = await client.callTool({
      name: 'automic_change_execution_status',
      arguments: { runId: 42, action: 'cancel' },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toMatchObject({
      outcome: 'cancel_requested',
      details_withheld: 'output_budget',
    });
    expect(posts(calls)).toHaveLength(1);
    expect(phases(logs)).toEqual(['attempt', 'sent', 'result:success']);
  });

  it('keeps OUTCOME UNKNOWN (not NOT APPLIED) when the outcome is unknown, with the secret masked', async () => {
    const { fetch, calls } = fakeFetch(json(exportOf(NOOP)), new Response('oops 51234', { status: 503 }));
    const { client, logs } = await connect(fetch, { ...WRITE, password: '1234', maxOutputChars: 60 });
    const result = await client.callTool({ name: 'automic_execute_object', arguments: { name: NOOP } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^OUTCOME UNKNOWN: .*Do not retry automatically/);
    expect(textOf(result)).not.toMatch(/NOT APPLIED|No execution was requested/);
    expect(JSON.stringify(result)).not.toContain('1234');
    expect(posts(calls)).toHaveLength(1);
    expect(phases(logs)).toEqual(['attempt', 'sent', 'result:unknown']);
  });
});

describe('a write whose log (stderr) fails while its result is checked', () => {
  /**
   * The action tools on a real MCP server whose every log line throws, with a given redactor.
   * The redactors below simulate defects, so that the runner has to log during its output check.
   */
  const connectBrokenLog = async (fetchImpl: typeof fetch, redact: Redactor) => {
    const config = { ...testConfig, ...WRITE, password: '1234' };
    const ctx: ToolContext = {
      client: new AutomicClient(config, redact, fetchImpl),
      config,
      redact,
      log: () => {
        throw new Error('stderr unavailable');
      },
    };
    const server = new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: { tools: {} } });
    registerActionTools(server, ctx, createRunner(ctx));
    return connectServer(server);
  };
  const secret = createRedactor(['1234']);
  /** Values are not redacted: the RunID 51234 reaches the final check, which must log and withhold it. */
  const unredactedValues: Redactor = { ...secret, value: (value) => value };
  /** Values cannot be rendered (simulated serialization error). */
  const unrenderable: Redactor = {
    ...secret,
    value: () => {
      throw new TypeError('Do not know how to serialize a BigInt');
    },
  };
  /** Free text is not redacted: the reconciliation text carries the account, taken here as the secret. */
  const unredactedText: Redactor = { ...createRedactor(['SVC_MCP/EXAMPLE']), text: (text) => text };
  const notApplied = /NOT APPLIED|Nothing was sent|No execution was requested|no request sent/i;

  it.each([
    ['its details are withheld (secret)', unredactedValues, 'secret'],
    ['its details cannot be rendered', unrenderable, 'render_error'],
  ])('stays a success when %s: one POST, no retry, nothing thrown', async (_label, redact, reason) => {
    const { fetch, calls } = fakeFetch(json(exportOf(NOOP)), json({ run_id: 51234 }));
    const client = await connectBrokenLog(fetch, redact);
    const result = await client.callTool({ name: 'automic_execute_object', arguments: { name: NOOP } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual({
      outcome: 'started',
      applied: true,
      details_withheld: reason,
      audit_logged: false,
      note: APPLIED_WITHHELD_NOTE,
    });
    expect(textOf(result)).not.toMatch(notApplied);
    expect(JSON.stringify(result)).not.toContain('1234');
    expect(posts(calls)).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it('keeps OUTCOME UNKNOWN when the outcome is unknown: one POST, no retry, nothing thrown', async () => {
    const { fetch, calls } = fakeFetch(json(exportOf(NOOP)), new Response('', { status: 503 }));
    const client = await connectBrokenLog(fetch, unredactedText);
    const result = await client.callTool({ name: 'automic_execute_object', arguments: { name: NOOP } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^OUTCOME UNKNOWN: details withheld .*Do not retry automatically/);
    expect(textOf(result)).not.toMatch(notApplied);
    expect(JSON.stringify(result)).not.toContain('SVC_MCP/EXAMPLE');
    expect(posts(calls)).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });
});

describe('automic_change_execution_status', () => {
  it('reads the execution, then the definition of its object, then cancels non-recursively', async () => {
    const { fetch, calls } = fakeFetch(json(sandboxRun), json(exportOf(SLEEP)), new Response('', { status: 200 }));
    const { client, logs } = await connect(fetch, WRITE);
    const result = await client.callTool({
      name: 'automic_change_execution_status',
      arguments: { runId: 42, action: 'cancel' },
    });
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      'GET /ae/api/v1/400/executions/42',
      `GET /ae/api/v1/400/objects/${SLEEP}`,
      'POST /ae/api/v1/400/executions/42/status',
    ]);
    expect(JSON.parse(calls[2]!.body!)).toEqual({ action: 'CANCEL', cancel: { recursive: false } });
    expect(JSON.parse(textOf(result))).toEqual({
      outcome: 'cancel_requested',
      object: SLEEP,
      run_id: 42,
      new_run_id: null,
      response: 'empty_body',
      audit_logged: true,
    });
    expect(phases(logs)).toEqual(['attempt', 'sent', 'result:success']);
    expect(audits(logs)[2]).toMatchObject({ action: 'cancel', run_id: 42, response: 'empty_body' });
  });

  it('refuses the recursive option (disabled) and unknown actions before any request', async () => {
    const { fetch, calls } = fakeFetch();
    const { client } = await connect(fetch, WRITE);
    for (const args of [
      { runId: 42, action: 'cancel', recursive: true },
      { runId: 42, action: 'cancel', recursive: false },
      { runId: 42, action: 'delete' },
    ]) {
      expect((await client.callTool({ name: 'automic_change_execution_status', arguments: args })).isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['the documented empty object', json({}), 'empty_object', null],
    ['a new run id', json({ run_id: 43 }), 'run_id', 43],
  ])('restarts and names the answer shape: %s', async (_label, reply, response, newRunId) => {
    const { fetch, calls } = fakeFetch(json(sandboxRun), json(exportOf(SLEEP)), reply);
    const { client } = await connect(fetch, WRITE);
    const result = await client.callTool({
      name: 'automic_change_execution_status',
      arguments: { runId: 42, action: 'restart' },
    });
    expect(JSON.parse(calls[2]!.body!)).toEqual({ action: 'RESTART' });
    expect(JSON.parse(textOf(result))).toMatchObject({ outcome: 'restart_requested', response, new_run_id: newRunId });
  });

  it('never turns an unexpected 2xx structure into a success', async () => {
    const { fetch, calls } = fakeFetch(json(sandboxRun), json(exportOf(SLEEP)), json({ unexpected: true }));
    const { client, logs } = await connect(fetch, WRITE);
    const result = await client.callTool({
      name: 'automic_change_execution_status',
      arguments: { runId: 42, action: 'restart' },
    });
    expect(textOf(result)).toMatch(/^OUTCOME UNKNOWN: Automic API returned an unexpected structure/);
    expect(textOf(result)).toContain('Reconcile (restart): automic_list_executions {"referenceRunId":42');
    expect(posts(calls)).toHaveLength(1);
    expect(phases(logs)).toEqual(['attempt', 'sent', 'result:unknown']);
  });

  it('lists every restart in the window as a candidate, never as proof (another operator restarted too)', async () => {
    const { fetch } = fakeFetch(json(sandboxRun), json(exportOf(SLEEP)), json({ unexpected: true }));
    const { client } = await connect(fetch, WRITE);
    const unknown = textOf(
      await client.callTool({ name: 'automic_change_execution_status', arguments: { runId: 42, action: 'restart' } }),
    );
    expect(unknown).toMatch(/^OUTCOME UNKNOWN/);
    // Following the suggested step: two restarts of 42 in the window, one by another operator.
    const restarts = [
      { ...sandboxRun, run_id: 43, reference_run_id: 42, user: 'OPERATOR/EXAMPLE' },
      { ...sandboxRun, run_id: 44, reference_run_id: 42, user: 'SVC_MCP/EXAMPLE' },
    ];
    const lookup = fakeFetch(json({ total: 2, hasmore: false, data: restarts }));
    const reader = await connect(lookup.fetch);
    const args = suggested(unknown);
    const listed = JSON.parse(
      textOf(await reader.client.callTool({ name: 'automic_list_executions', arguments: args })),
    );
    expect(Object.fromEntries(lookup.calls[0]!.url.searchParams)).toMatchObject({
      reference_run_id: '42',
      include_deactivated: 'true',
      time_frame_option: 'activation',
      time_frame_from: args.timeFrom,
      time_frame_to: args.timeTo,
    });
    expect(listed.executions.map((run: { run_id: number }) => run.run_id)).toEqual([43, 44]);
    expect(unknown).toContain('is only a candidate');
    expect(unknown).not.toMatch(/\bproves?\b/);
  });

  it.each([
    ['cancel', 'JOBP'],
    ['restart', 'JOBP'],
    ['cancel', 'JSCH'],
    ['cancel', 'XYZ'],
  ] as const)('refuses to %s a %s execution, even of a reviewed name, before any POST', async (action, type) => {
    const { fetch, calls } = fakeFetch(json({ ...sandboxRun, type }));
    const { client, logs } = await connect(fetch, WRITE);
    const result = await client.callTool({ name: 'automic_change_execution_status', arguments: { runId: 42, action } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(
      new RegExp(`^NOT APPLIED: ${action} of a ${type} execution is refused.*No status change was sent\\.$`),
    );
    expect(calls.map((call) => call.method)).toEqual(['GET']);
    expect(phases(logs)).toEqual(['attempt', 'blocked:blocked']);
    expect(audits(logs)[1]).toMatchObject({ error_kind: 'type_not_allowed', object: SLEEP });
  });

  it('does not accept a SCRI for its type: an unreviewed activator script is refused before any POST', async () => {
    const activator = { ...sandboxRun, name: 'MCP.SANDBOX.ACTIVATOR.SCRI' };
    const { fetch, calls } = fakeFetch(json(activator));
    const { client, logs } = await connect(fetch, WRITE);
    const result = await client.callTool({
      name: 'automic_change_execution_status',
      arguments: { runId: 42, action: 'cancel' },
    });
    expect(textOf(result)).toBe(
      'NOT APPLIED: "MCP.SANDBOX.ACTIVATOR.SCRI" is not a reviewed object for cancel (AUTOMIC_CANCEL_ALLOWLIST). ' +
        'No status change was sent.',
    );
    expect(posts(calls)).toHaveLength(0);
    expect(audits(logs)[1]).toMatchObject({ error_kind: 'not_reviewed' });
  });

  it('keeps the scopes separate: reviewed for cancel does not authorize restart', async () => {
    const { fetch, calls } = fakeFetch(json(sandboxRun));
    const { client } = await connect(fetch, {
      enableWrite: true,
      writeScope: { execute: [], cancel: [reviewed(SLEEP)], restart: [] },
    });
    const result = await client.callTool({
      name: 'automic_change_execution_status',
      arguments: { runId: 42, action: 'restart' },
    });
    expect(textOf(result)).toContain('is not a reviewed object for restart (AUTOMIC_RESTART_ALLOWLIST)');
    expect(posts(calls)).toHaveLength(0);
  });

  it.each([
    ['its definition changed since the review', json(exportOf(SLEEP, 'SCRI', ':WAIT 10')), 'definition_changed'],
    ['the export type differs from the execution type', json(exportOf(SLEEP, 'JOBS')), 'type_not_allowed'],
  ])('refuses a reviewed SCRI execution when %s, before any POST', async (_label, answer, reason) => {
    const { fetch, calls } = fakeFetch(json(sandboxRun), answer);
    const { client, logs } = await connect(fetch, WRITE);
    const result = await client.callTool({
      name: 'automic_change_execution_status',
      arguments: { runId: 42, action: 'cancel' },
    });
    expect(textOf(result)).toMatch(/^NOT APPLIED: .*No status change was sent\.$/);
    expect(posts(calls)).toHaveLength(0);
    expect(audits(logs)[1]).toMatchObject({ error_kind: reason });
  });

  it.each([
    ['a timeout', [new DOMException('timed out', 'TimeoutError')]],
    ['a 5xx', [new Response('oops', { status: 503 })]],
    ['a 404', [json({ code: 45212, error: 'not found' }, 404)]],
    ['a failed read of the definition', [json(sandboxRun), new Response('oops', { status: 503 })]],
  ])('reports a failed precheck (%s) as NOT APPLIED: no status change was sent', async (_label, replies) => {
    const { fetch, calls } = fakeFetch(...replies);
    const { client, logs } = await connect(fetch, WRITE);
    const result = await client.callTool({
      name: 'automic_change_execution_status',
      arguments: { runId: 42, action: 'restart' },
    });
    expect(textOf(result)).toMatch(/^NOT APPLIED: precheck failed\. No status change was sent\. Automic API/);
    expect(posts(calls)).toHaveLength(0);
    expect(phases(logs)).toEqual(['attempt', 'precheck_failed:not_sent']);
  });

  it('reports OUTCOME UNKNOWN on a 5xx of the mutation and never retries', async () => {
    const { fetch, calls } = fakeFetch(json(sandboxRun), json(exportOf(SLEEP)), new Response('oops', { status: 503 }));
    const { client } = await connect(fetch, WRITE);
    const result = await client.callTool({
      name: 'automic_change_execution_status',
      arguments: { runId: 42, action: 'cancel' },
    });
    expect(textOf(result)).toMatch(
      /^OUTCOME UNKNOWN: Automic API 503 .*Reconcile \(cancel\): automic_get_execution \{"runId":42\}/,
    );
    expect(posts(calls)).toHaveLength(1);
  });
});
