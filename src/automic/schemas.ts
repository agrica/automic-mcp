import * as z from 'zod';

// Runtime contracts for the AE REST API v1 payloads the tools consume.
// Unknown fields are stripped (zod default), which also minimizes what reaches the model.
// Sources: docs/reference/ae-rest-24.4.json + fixtures in tests/fixtures (observed answers).

export const OutError = z.object({
  code: z.number().optional(),
  error: z.string(),
  details: z.string().optional(),
});

/** 400 on POST /executions is documented as an array of OutValidationError. */
export const OutValidationErrors = z.array(z.object({ code: z.number().optional(), error: z.string() }));

/** ResultInfo (spec 24.4): `start_at` of the request is an index into the `total` matches. */
export const SearchResponse = z.object({
  total: z.number().int().nonnegative(),
  hasmore: z.boolean(),
  indexing_in_progress: z.boolean().optional(),
  data: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      sub_type: z.string().optional(),
      platform: z.string().optional(),
      title: z.string().optional(),
      folder_path: z.string().optional(),
      is_inactive: z.string().optional(),
      modified_by: z.string().optional(),
      modified_date: z.number().optional(),
    }),
  ),
});

export const Execution = z.object({
  run_id: z.number().int(),
  name: z.string(),
  type: z.string(),
  status: z.number().int(),
  status_text: z.string().optional(),
  activation_time: z.string().optional(),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  agent: z.string().optional(),
  queue: z.string().optional(),
  user: z.string().optional(),
  parent: z.number().int().optional(),
  alias: z.string().optional(),
  /** Documented: "RunID of the original execution, zero if this was not a restart". */
  reference_run_id: z.number().int().optional(),
});
export type Execution = z.infer<typeof Execution>;

export const ExecutionList = z.object({
  total: z.number().int(),
  hasmore: z.boolean(),
  data: z.array(Execution),
});

export const ReportList = z.array(
  z.object({
    type: z.string(),
    end_timestamp: z.string().optional(),
    is_db: z.boolean().optional(),
    is_xml: z.boolean().optional(),
  }),
);

/** Observed shape ({total, data}); the published spec documents a bare array. */
export const ReportPages = z.object({
  total: z.number().int().nonnegative(),
  data: z.array(z.object({ page: z.number().int().positive(), content: z.string() })),
});
export type ReportPages = z.infer<typeof ReportPages>;

export const ObjectExport = z.object({
  total: z.number().int().optional(),
  path: z.string().optional(),
  client: z.number().int().optional(),
  data: z.record(z.string(), z.unknown()),
});

export const ObjectUsage = z.object({
  references: z.array(z.record(z.string(), z.unknown())).optional(),
  references_without_a_c_l: z.boolean().optional(),
  number_of_referencing_objects: z.number().int().optional(),
  total_number_of_references: z.number().int().optional(),
});

export const SystemInfo = z.record(z.string(), z.unknown());

export const RunId = z.object({ run_id: z.number().int().positive() });

/**
 * OutChangeExecutionStatus (spec 24.4): {run_id?} — run_id of the restarted execution.
 * Strict: any other field is an unexpected structure (invalid_response), never a silent success.
 * An empty body is accepted separately by the client (allowEmpty), hypothesis H6.
 */
export const ChangeStatusResult = z.object({ run_id: z.number().int().positive().optional() }).strict();
