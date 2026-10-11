// Answers observed on an Automic 24.4 non-production system on 2026-10-11, anonymized
// (object, agent, user and queue names replaced; structure and value types unchanged).

/**
 * GET /{client}/executions?max_results=1&status=1800,1900&time_frame_option=activation&time_frame_from=...
 * Note: total=27 with one item returned, yet hasmore=false — hasmore cannot drive continuation.
 */
export const executionList = {
  total: 27,
  hasmore: false,
  data: [
    {
      name: 'APP.TEAM.DETECT_FILE.JOBS',
      type: 'JOBS',
      queue: 'APP.TEAM.QUEUE',
      run_id: 5614648,
      status: 1800,
      status_text: 'ENDED_NOT_OK - aborted',
      runtime: 1,
      activation_time: '2026-10-11T11:30:49Z',
      start_time: '2026-10-11T11:30:50Z',
      end_time: '2026-10-11T11:30:51Z',
      agent: 'AGENT01',
      platform: 'UNIX',
      parent: 0,
      reference_run_id: 0,
      user: 'USER01/EXAMPLE',
      estimated_runtime: 1,
      title: 'Sample job title',
      alias: 'APP.TEAM.DETECT_FILE.JOBS',
      activator: 5614647,
      activator_object_type: 'USER',
      priority: 200,
    },
  ],
};

/** GET /{client}/executions/{run_id}/reports */
export const reportList = [
  { end_timestamp: '2026-10-11T11:30:51Z', type: 'ACT', is_db: true },
  { end_timestamp: '2026-10-11T11:30:51Z', type: 'POST', is_db: true },
  { end_timestamp: '2026-10-11T11:30:51Z', type: 'REP', is_db: true },
];

/** GET /{client}/executions/{run_id}/reports/REP?max_results=1 — {total, data}, not the documented bare array. */
export const reportOnePage = {
  total: 1,
  data: [{ page: 1, content: '** JOB 0005614648 START **\r\nnumber of files in directory /in: 1\r\n' }],
};

/** POST /{client}/search (first hit, fields trimmed to those present). */
export const searchResult = {
  total: 1,
  hasmore: false,
  data: [
    {
      name: 'APP.TEAM.CALL_API.JOBS',
      type: 'JOBS',
      sub_type: '',
      platform: 'UNIX',
      id: '1033118',
      title: 'Call API',
      folder_path: '\\TEAM\\APP\\JOB',
      is_inactive: '0',
      agent: 'AGENT02',
      login: 'LOGIN.SAMPLE',
      modified_by: 'USER01/EXAMPLE',
      modified_date: 1764163952000,
      score: 4.54,
    },
  ],
};

/** GET /{client}/objects/{unknown} */
export const objectNotFound = {
  code: 45212,
  error: "Object 'DOES.NOT.EXIST' not found.",
  details: 'No detail information available.',
};

/** GET /{client}/system/health with a non-admin account */
export const healthForbidden = {
  code: 9,
  error: 'Permission check failed.',
  details: "'Missing privilege': Access denied",
};

/** Any call without Authorization header */
export const missingAuth = {
  code: 45229,
  error: 'Authorization header is missing.',
  details: 'No detail information available.',
};
