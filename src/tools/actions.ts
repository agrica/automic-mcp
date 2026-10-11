import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { seg } from '../automic/client.js';
import { AutomicApiError, ToolInputError, WriteOutcomeUnknownError } from '../automic/errors.js';
import { ChangeStatusResult, Execution, ObjectExport, RunId } from '../automic/schemas.js';
import { type ReviewedObject, SCOPE_VARIABLES, type WriteAction } from '../config.js';
import { clip, type Redactor } from '../security/redact.js';
import type { ToolContext } from './context.js';
import { exportedType, objectFingerprint } from './objects.js';
import { Applied, type Runner } from './result.js';

// Hints help the host decide when to ask the user; they are NOT an authorization mechanism.
// Authorization = Automic rights of the technical account + reviewed objects per action
// (AUTOMIC_EXECUTE/CANCEL/RESTART_ALLOWLIST, pinned definitions) + host approval.
const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

/** Margin for clock skew between this host and Automic in reconciliation time windows. */
const RECONCILE_MARGIN_MS = 60_000;
const AUDIT_TEXT_MAX = 200;
const AUDIT_KEYS_MAX = 20;
const AUDIT_FAILED_NOTE = ' [audit log could not be written]';

/**
 * ADDITIONAL restriction on every write: the object type must be one of these. It is NOT a proof that
 * the object has no descendants or indirect effects: a SCRI can activate other objects
 * (ACTIVATE_UC_OBJECT), a JOBS can call the Automic API. Authorization comes from the per-action review
 * of the exact object (AUTOMIC_*_ALLOWLIST, pinned fingerprint). Containers (JOBP, JSCH...) and any
 * other type are refused before any mutation.
 */
export const WRITE_OBJECT_TYPES: readonly string[] = ['JOBS', 'JOBF', 'SCRI'];

/** Why a write was refused before any mutation (audit `error_kind` of a `blocked` event). */
export type BlockReason = 'not_reviewed' | 'type_not_allowed' | 'not_exportable' | 'definition_changed';

export type WriteOutcome = 'success' | 'refused' | 'not_sent' | 'unknown' | 'blocked';

/**
 * attempt: the tool was called (before any check); blocked: refused by the allowlist, nothing sent;
 * precheck_failed: the GET before a status change failed, no mutation sent; sent: the mutation is
 * about to be sent; result: what came back (success, refused, not_sent or unknown).
 */
export type AuditPhase = 'attempt' | 'blocked' | 'precheck_failed' | 'sent' | 'result';

/** How Automic answered a status change: all three are accepted, anything else is invalid_response. */
export type StatusResponse = 'empty_body' | 'empty_object' | 'run_id';

export interface AuditEvent {
  tool: string;
  phase: AuditPhase;
  object?: string;
  run_id?: number;
  action?: string;
  outcome?: WriteOutcome;
  http_status?: number;
  error_kind?: string;
  new_run_id?: number;
  response?: StatusResponse;
  /** Names of the PromptSet variables, never their values. */
  input_keys?: string[];
}

/** One audit line: the event is redacted, THEN its free-text fields are bounded. */
export function formatAudit(event: AuditEvent, redact: Redactor, client: number, now: Date): string {
  const safe = redact.value(event) as AuditEvent;
  const bounded: Record<string, unknown> = { ...safe };
  if (safe.object !== undefined) bounded.object = clip(safe.object, AUDIT_TEXT_MAX);
  if (safe.input_keys !== undefined) {
    bounded.input_keys = safe.input_keys.slice(0, AUDIT_KEYS_MAX).map((key) => clip(key, 64));
    bounded.input_key_count = safe.input_keys.length;
  }
  return JSON.stringify({ ts: now.toISOString(), event: 'automic_write', client, ...bounded });
}

/** The reviewed entry for this exact object name (case-insensitive), or undefined. No wildcard. */
export function findReviewed(objectName: string, reviewed: readonly ReviewedObject[]): ReviewedObject | undefined {
  const name = objectName.toUpperCase();
  return reviewed.find((entry) => entry.name === name);
}

/** Request bodies follow the official examples of spec 24.4 (snake_case, upper-case actions) — hypothesis H1. */
export function buildExecutionBody(args: {
  name: string;
  inputs?: Record<string, string> | undefined;
  queue?: string | undefined;
  alias?: string | undefined;
}) {
  return {
    object_name: args.name,
    execution_option: 'execute',
    ...(args.inputs === undefined ? {} : { inputs: args.inputs }),
    ...(args.queue === undefined ? {} : { queue: args.queue }),
    ...(args.alias === undefined ? {} : { alias: args.alias }),
  };
}

/** Cancel is never recursive: descendants are not checked against the allowlist (no atomic check exists). */
export function buildStatusBody(action: 'cancel' | 'restart') {
  return action === 'cancel' ? { action: 'CANCEL', cancel: { recursive: false } } : { action: 'RESTART' };
}

export function statusResponse(result: { run_id?: number | undefined } | undefined): StatusResponse {
  if (result === undefined) return 'empty_body';
  return result.run_id === undefined ? 'empty_object' : 'run_id';
}

/**
 * Read-only steps that gather CANDIDATES after an OUTCOME UNKNOWN; none of them is a retry and none of
 * them proves anything: Automic returns no identifier of the HTTP request, so a matching execution can
 * come from another operator or from an earlier action inside the time window. The outcome stays
 * UNKNOWN until a human decides. Window: activation time in [sent - margin, failed + margin], deactivated
 * executions included (a short task can end and be deactivated before the check).
 */
export function reconcileGuide(
  kind: 'launch' | 'cancel' | 'restart',
  target: { name?: string; runId?: number; account: string; since: string; until: string },
): string {
  const window = {
    includeDeactivated: true,
    timeFrameOption: 'activation',
    timeFrom: target.since,
    timeTo: target.until,
  };
  const stays =
    'The outcome stays UNKNOWN: these are candidates for a human decision in the AWI, not proof, and no step is a retry.';
  switch (kind) {
    case 'launch':
      return (
        `Reconcile (launch): automic_list_executions ${JSON.stringify({ name: target.name, ...window })}. ` +
        `Each execution listed is only a candidate: compare its user with ${target.account} and its activation time ` +
        `with this request; another start of the same object in the window gives the same match. ${stays}`
      );
    case 'cancel':
      return (
        `Reconcile (cancel): automic_get_execution ${JSON.stringify({ runId: target.runId })}. ` +
        'A status still active means not applied yet; an ended or cancelled status does not show that this ' +
        `request ended it (the task may have ended on its own, or been cancelled by someone else). ${stays}`
      );
    case 'restart':
      return (
        `Reconcile (restart): automic_list_executions ${JSON.stringify({ referenceRunId: target.runId, ...window })}. ` +
        `Each execution with reference_run_id = ${target.runId} is only a candidate: that field names the original ` +
        'execution, not the request that restarted it, so a restart by another operator, or an earlier restart ' +
        `inside the time margin, matches too. Compare user (${target.account}) and activation time. ${stays}`
      );
  }
}

export function registerActionTools(server: McpServer, ctx: ToolContext, safe: Runner): void {
  const account = `${ctx.config.user}/${ctx.config.department}`;
  const scope = ctx.config.writeScope;

  /** Audit trail of one tool call. A logging failure never changes the action result; it is reported beside it. */
  const trail = (base: Omit<AuditEvent, 'phase'>) => {
    let logged = true;
    return {
      log(event: Partial<AuditEvent> & { phase: AuditPhase }): void {
        try {
          ctx.log(formatAudit({ ...base, ...event }, ctx.redact, ctx.config.client, new Date()));
        } catch {
          logged = false;
        }
      },
      get logged(): boolean {
        return logged;
      },
      note(message: string): string {
        return logged ? message : `${message}${AUDIT_FAILED_NOTE}`;
      },
    };
  };
  type Trail = ReturnType<typeof trail>;

  const errorFields = (err: unknown) =>
    err instanceof AutomicApiError ? { http_status: err.status, error_kind: err.kind } : {};

  /** Classifies a failed mutation; never retries. */
  const failure = (err: unknown, audit: Trail, reconcile: string): Error => {
    if (err instanceof AutomicApiError && !err.outcomeUnknown) {
      audit.log({ phase: 'result', outcome: err.kind === 'unreachable' ? 'not_sent' : 'refused', ...errorFields(err) });
      return new ToolInputError(audit.note(`NOT APPLIED: ${err.message}`));
    }
    audit.log({ phase: 'result', outcome: 'unknown', ...errorFields(err) });
    const reason = err instanceof Error ? err.message : 'unexpected error';
    return new WriteOutcomeUnknownError(
      audit.note(
        `OUTCOME UNKNOWN: ${reason}. The request may have been applied by Automic. Do not retry automatically. ${reconcile}`,
      ),
    );
  };

  /** What was certainly not sent, in the words of each tool. */
  const NOT_SENT: Record<WriteAction, string> = {
    execute: 'No execution was requested.',
    cancel: 'No status change was sent.',
    restart: 'No status change was sent.',
  };

  /** Refusal before any mutation: audited as blocked, reported as NOT APPLIED. */
  const block = (audit: Trail, action: WriteAction, object: string, reason: BlockReason, detail: string): Error => {
    audit.log({ phase: 'blocked', object, outcome: 'blocked', error_kind: reason });
    return new ToolInputError(audit.note(`NOT APPLIED: ${detail} ${NOT_SENT[action]}`));
  };

  /** A failed read before the mutation: whatever its cause, the mutation was not sent. */
  const precheckFailed = (audit: Trail, action: WriteAction, err: unknown): Error => {
    audit.log({ phase: 'precheck_failed', outcome: 'not_sent', ...errorFields(err) });
    const reason = err instanceof Error ? err.message : 'unexpected error';
    return new ToolInputError(audit.note(`NOT APPLIED: precheck failed. ${NOT_SENT[action]} ${reason}`));
  };

  /**
   * The object must be reviewed for THIS action, of an allowed type, and its current definition must
   * still be the reviewed one. Reads only; the mutation follows later, so this is not atomic: a change
   * between this read and the mutation is not detected (documented limit).
   */
  const authorize = async (action: WriteAction, objectName: string, audit: Trail, executionType?: string) => {
    const reviewed = findReviewed(objectName, scope[action]);
    if (reviewed === undefined) {
      throw block(
        audit,
        action,
        objectName,
        'not_reviewed',
        `"${clip(objectName, 200)}" is not a reviewed object for ${action} (${SCOPE_VARIABLES[action]}).`,
      );
    }
    if (executionType !== undefined && !WRITE_OBJECT_TYPES.includes(executionType)) {
      throw block(
        audit,
        action,
        objectName,
        'type_not_allowed',
        `${action} of a ${clip(executionType, 16)} execution is refused (write tools accept only ${WRITE_OBJECT_TYPES.join(', ')}).`,
      );
    }
    let data: Record<string, unknown>;
    try {
      data = (await ctx.client.get(`/objects/${seg(objectName)}`, ObjectExport)).data;
    } catch (err) {
      throw precheckFailed(audit, action, err);
    }
    let type: string;
    try {
      type = exportedType(data);
    } catch {
      throw block(audit, action, objectName, 'not_exportable', 'the object definition cannot be checked.');
    }
    if (!WRITE_OBJECT_TYPES.includes(type) || (executionType !== undefined && type !== executionType)) {
      throw block(
        audit,
        action,
        objectName,
        'type_not_allowed',
        `${action} of a ${clip(type, 16)} object is refused (write tools accept only ${WRITE_OBJECT_TYPES.join(', ')}).`,
      );
    }
    if (objectFingerprint(data) !== reviewed.fingerprint) {
      throw block(
        audit,
        action,
        objectName,
        'definition_changed',
        `the definition of "${clip(objectName, 200)}" differs from the reviewed one: review it again and update ` +
          `${SCOPE_VARIABLES[action]}.`,
      );
    }
  };

  const since = () => new Date(Date.now() - RECONCILE_MARGIN_MS).toISOString();
  const until = () => new Date(Date.now() + RECONCILE_MARGIN_MS).toISOString();

  if (scope.execute.length > 0) {
    server.registerTool(
      'automic_execute_object',
      {
        title: 'Execute Automic object',
        description:
          'Starts a reviewed object immediately. Only the exact objects of AUTOMIC_EXECUTE_ALLOWLIST whose ' +
          'definition still matches the reviewed fingerprint, of type JOBS, JOBF or SCRI. ' +
          'Never retried: on OUTCOME UNKNOWN, follow the reconciliation steps before any new attempt.',
        inputSchema: z
          .object({
            name: z.string().min(1).describe('Exact object name'),
            inputs: z
              .record(z.string().min(1), z.string())
              .optional()
              .describe('PromptSet variables, e.g. {"VAR#": "X"}'),
            queue: z.string().min(1).optional(),
            alias: z.string().min(1).optional(),
          })
          .strict(),
        annotations: WRITE,
      },
      safe(async (args) => {
        const audit = trail({
          tool: 'automic_execute_object',
          object: args.name,
          input_keys: Object.keys(args.inputs ?? {}),
        });
        audit.log({ phase: 'attempt' });
        await authorize('execute', args.name, audit);
        const requestedAt = since();
        audit.log({ phase: 'sent' });
        let runId: number;
        try {
          const result = await ctx.client.post('/executions', buildExecutionBody(args), RunId);
          if (result === undefined) throw new AutomicApiError('invalid_response', 200, 'empty answer');
          runId = result.run_id;
        } catch (err) {
          throw failure(
            err,
            audit,
            reconcileGuide('launch', { name: args.name, account, since: requestedAt, until: until() }),
          );
        }
        audit.log({ phase: 'result', outcome: 'success', new_run_id: runId });
        return new Applied('started', { object: args.name, run_id: runId }, audit.logged);
      }),
    );
  }

  if (scope.cancel.length > 0 || scope.restart.length > 0) {
    server.registerTool(
      'automic_change_execution_status',
      {
        title: 'Cancel or restart Automic execution',
        description:
          'Cancels (never recursively) or restarts an execution of a reviewed object: the exact objects of ' +
          'AUTOMIC_CANCEL_ALLOWLIST or AUTOMIC_RESTART_ALLOWLIST (one list per action) whose definition still ' +
          'matches the reviewed fingerprint, of type JOBS, JOBF or SCRI. Workflows and other containers are refused. ' +
          'Never retried: on OUTCOME UNKNOWN, follow the reconciliation steps before any new attempt.',
        inputSchema: z
          .object({
            runId: z.number().int().positive(),
            action: z.enum(['cancel', 'restart']),
          })
          .strict(),
        annotations: WRITE,
      },
      safe(async ({ runId, action }) => {
        const audit = trail({ tool: 'automic_change_execution_status', run_id: runId, action });
        audit.log({ phase: 'attempt' });
        let execution: Execution;
        try {
          execution = await ctx.client.get(`/executions/${seg(runId)}`, Execution);
        } catch (err) {
          throw precheckFailed(audit, action, err);
        }
        await authorize(action, execution.name, audit, execution.type);
        const requestedAt = since();
        audit.log({ phase: 'sent', object: execution.name });
        let result: { run_id?: number | undefined } | undefined;
        try {
          result = await ctx.client.post(
            `/executions/${seg(runId)}/status`,
            buildStatusBody(action),
            ChangeStatusResult,
            true,
          );
        } catch (err) {
          throw failure(err, audit, reconcileGuide(action, { runId, account, since: requestedAt, until: until() }));
        }
        const response = statusResponse(result);
        audit.log({
          phase: 'result',
          object: execution.name,
          outcome: 'success',
          response,
          ...(result?.run_id === undefined ? {} : { new_run_id: result.run_id }),
        });
        return new Applied(
          action === 'cancel' ? 'cancel_requested' : 'restart_requested',
          { object: execution.name, run_id: runId, new_run_id: result?.run_id ?? null, response },
          audit.logged,
        );
      }),
    );
  }
}
