/** One reviewed object: exact name + fingerprint of the definition that was reviewed. */
export interface ReviewedObject {
  name: string;
  /** `sha256:<64 hex>` of the canonical export (see objectFingerprint, task 6). */
  fingerprint: string;
}

/** Write scope, separate per action. An empty list disables the action. */
export interface WriteScope {
  execute: readonly ReviewedObject[];
  cancel: readonly ReviewedObject[];
  restart: readonly ReviewedObject[];
}

export type WriteAction = keyof WriteScope;

export const SCOPE_VARIABLES: Record<WriteAction, string> = {
  execute: 'AUTOMIC_EXECUTE_ALLOWLIST',
  cancel: 'AUTOMIC_CANCEL_ALLOWLIST',
  restart: 'AUTOMIC_RESTART_ALLOWLIST',
};

export interface AutomicConfig {
  /** Origin + path, no trailing slash, no credentials/query/fragment. */
  baseUrl: string;
  /** Automic client number, 1..9999 (client 0 is refused). */
  client: number;
  user: string;
  department: string;
  password: string;
  enableWrite: boolean;
  /** Reviewed objects per write action (exact names, pinned definitions). At least one when enableWrite. */
  writeScope: WriteScope;
  timeoutMs: number;
  maxResponseBytes: number;
  reportMaxChars: number;
  /** Budget of one MCP tool result (all text blocks). Over budget = tool error, never truncated JSON. */
  maxOutputChars: number;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const NAME_PART = /^[^/:\s]+$/;
/** `NAME@sha256:<64 hex>`: exact object name (no wildcard), pinned to the reviewed definition. */
const REVIEWED_ENTRY = /^([A-Za-z0-9_.$#@-]+)@(sha256:[0-9a-f]{64})$/;
/** Room kept in the output budget for report metadata and the untrusted-data notice. */
export const REPORT_OVERHEAD_CHARS = 5_000;

/** Reads the configuration. Error messages name variables, never their values. */
export function loadConfig(env: Record<string, string | undefined>): AutomicConfig {
  const problems: string[] = [];
  const read = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value === undefined || value === '' ? undefined : value;
  };
  const required = (name: string): string => {
    const value = read(name);
    if (value === undefined) problems.push(`${name} is required`);
    return value ?? '';
  };
  const flag = (name: string): boolean => {
    const value = read(name)?.toLowerCase();
    if (value === undefined || value === 'false') return false;
    if (value === 'true') return true;
    problems.push(`${name} must be "true" or "false"`);
    return false;
  };
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const value = read(name);
    if (value === undefined) return fallback;
    const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    if (!(parsed >= min && parsed <= max)) {
      problems.push(`${name} must be an integer between ${min} and ${max}`);
      return fallback;
    }
    return parsed;
  };

  const allowInsecureHttp = flag('AUTOMIC_ALLOW_INSECURE_HTTP');
  const baseUrl = parseBaseUrl(required('AUTOMIC_BASE_URL'), allowInsecureHttp, problems);

  const clientText = required('AUTOMIC_CLIENT');
  let client = 0;
  if (clientText !== '') {
    if (!/^\d{1,4}$/.test(clientText)) problems.push('AUTOMIC_CLIENT must be a number from 1 to 9999');
    else if (Number(clientText) === 0) problems.push('AUTOMIC_CLIENT 0 (system client) is not supported');
    else client = Number(clientText);
  }

  const user = required('AUTOMIC_USER');
  const department = required('AUTOMIC_DEPARTMENT');
  for (const [name, value] of [
    ['AUTOMIC_USER', user],
    ['AUTOMIC_DEPARTMENT', department],
  ] as const) {
    if (value !== '' && !NAME_PART.test(value)) problems.push(`${name} must not contain "/", ":" or whitespace`);
  }

  // The password is used verbatim: no trimming.
  const password = env.AUTOMIC_PASSWORD ?? '';
  if (password === '') problems.push('AUTOMIC_PASSWORD is required');

  const enableWrite = flag('AUTOMIC_ENABLE_WRITE');
  if (read('AUTOMIC_WRITE_ALLOWLIST') !== undefined) {
    problems.push(
      'AUTOMIC_WRITE_ALLOWLIST is no longer supported: use AUTOMIC_EXECUTE_ALLOWLIST, AUTOMIC_CANCEL_ALLOWLIST ' +
        'and AUTOMIC_RESTART_ALLOWLIST (NAME@sha256:<fingerprint> entries)',
    );
  }
  const reviewed = (variable: string): ReviewedObject[] => {
    const entries = (read(variable) ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
    const parsed: ReviewedObject[] = [];
    for (const entry of entries) {
      const [, name, fingerprint] = REVIEWED_ENTRY.exec(entry) ?? [];
      if (name === undefined || fingerprint === undefined) {
        problems.push(`${variable} must list NAME@sha256:<64 lowercase hex> entries (exact names, no wildcard)`);
        return [];
      }
      parsed.push({ name: name.toUpperCase(), fingerprint });
    }
    if (new Set(parsed.map((entry) => entry.name)).size !== parsed.length) {
      problems.push(`${variable} lists the same object more than once`);
      return [];
    }
    return parsed;
  };
  const writeScope: WriteScope = {
    execute: reviewed(SCOPE_VARIABLES.execute),
    cancel: reviewed(SCOPE_VARIABLES.cancel),
    restart: reviewed(SCOPE_VARIABLES.restart),
  };
  const scopeSize = writeScope.execute.length + writeScope.cancel.length + writeScope.restart.length;
  if (enableWrite && scopeSize === 0) {
    problems.push(
      'AUTOMIC_ENABLE_WRITE=true requires at least one reviewed object in AUTOMIC_EXECUTE_ALLOWLIST, ' +
        'AUTOMIC_CANCEL_ALLOWLIST or AUTOMIC_RESTART_ALLOWLIST',
    );
  }

  const config: AutomicConfig = {
    baseUrl,
    client,
    user,
    department,
    password,
    enableWrite,
    writeScope,
    timeoutMs: integer('AUTOMIC_TIMEOUT_MS', 30_000, 1_000, 300_000),
    maxResponseBytes: integer('AUTOMIC_MAX_RESPONSE_BYTES', 5 * 1024 * 1024, 1024, 100 * 1024 * 1024),
    reportMaxChars: integer('AUTOMIC_REPORT_MAX_CHARS', 20_000, 1_000, 1_000_000),
    maxOutputChars: integer('AUTOMIC_MAX_OUTPUT_CHARS', 100_000, 10_000, 2_000_000),
  };
  // A report result = metadata + notice + content: the content limit must leave room for the rest.
  if (config.reportMaxChars + REPORT_OVERHEAD_CHARS > config.maxOutputChars) {
    problems.push(`AUTOMIC_REPORT_MAX_CHARS must be at most AUTOMIC_MAX_OUTPUT_CHARS - ${REPORT_OVERHEAD_CHARS}`);
  }
  if (problems.length > 0) {
    throw new ConfigError(`Invalid Automic configuration:\n- ${problems.join('\n- ')}`);
  }
  return config;
}

function parseBaseUrl(raw: string, allowInsecureHttp: boolean, problems: string[]): string {
  if (raw === '') return '';
  const url = URL.parse(raw);
  if (url === null) {
    problems.push('AUTOMIC_BASE_URL is not a valid URL');
    return '';
  }
  if (url.username !== '' || url.password !== '') problems.push('AUTOMIC_BASE_URL must not contain credentials');
  if (raw.includes('?') || raw.includes('#')) problems.push('AUTOMIC_BASE_URL must not contain a query or fragment');
  if (url.protocol === 'http:') {
    if (!allowInsecureHttp) {
      problems.push(
        'AUTOMIC_BASE_URL uses http:// (credentials sent unencrypted): set AUTOMIC_ALLOW_INSECURE_HTTP=true',
      );
    }
  } else if (url.protocol !== 'https:') {
    problems.push('AUTOMIC_BASE_URL must use https:// (or http:// with AUTOMIC_ALLOW_INSECURE_HTTP=true)');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}
