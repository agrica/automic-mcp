import type * as z from 'zod';
import type { AutomicConfig } from '../config.js';
import { clip, type Redactor } from '../security/redact.js';
import { AutomicApiError, ToolInputError } from './errors.js';
import { OutError, OutValidationErrors } from './schemas.js';

export type QueryValue = string | number | boolean | readonly (string | number)[] | undefined;
export type Query = Record<string, QueryValue>;

interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** An empty 2xx body is accepted (ping, status change); otherwise it is an error. */
  allowEmpty?: boolean;
}

const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);
const DEFAULT_DETAILS = 'No detail information available.';

/** Encodes one URL path segment; '.', '..' and '' are refused (they would change the path). */
export function seg(value: string | number): string {
  const text = String(value);
  if (text === '' || text === '.' || text === '..') throw new ToolInputError(`Invalid path segment: "${text}"`);
  return encodeURIComponent(text);
}

export class AutomicClient {
  readonly #baseUrl: string;
  readonly #clientId: number;
  readonly #authorization: string;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #fetch: typeof fetch;
  readonly #redact: Redactor;

  constructor(config: AutomicConfig, redact: Redactor, fetchImpl: typeof fetch = globalThis.fetch) {
    this.#baseUrl = config.baseUrl;
    this.#clientId = config.client;
    this.#timeoutMs = config.timeoutMs;
    this.#maxBytes = config.maxResponseBytes;
    this.#fetch = fetchImpl;
    this.#redact = redact;
    this.#authorization = `Basic ${basicToken(config)}`;
  }

  get clientId(): number {
    return this.#clientId;
  }

  async ping(): Promise<void> {
    await this.#request('GET', '/ping', { allowEmpty: true });
  }

  async get<S extends z.ZodType>(path: string, schema: S, query?: Query): Promise<z.output<S>> {
    const scoped = `/${this.#clientId}${path}`;
    return this.#validate('GET', scoped, schema, await this.#request('GET', scoped, query ? { query } : {}));
  }

  async post<S extends z.ZodType>(
    path: string,
    body: unknown,
    schema: S,
    allowEmpty = false,
  ): Promise<z.output<S> | undefined> {
    const scoped = `/${this.#clientId}${path}`;
    const json = await this.#request('POST', scoped, { body, allowEmpty });
    return json === undefined ? undefined : this.#validate('POST', scoped, schema, json);
  }

  #validate<S extends z.ZodType>(method: string, path: string, schema: S, json: unknown): z.output<S> {
    const parsed = schema.safeParse(json);
    if (parsed.success) return parsed.data;
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)'))].slice(0, 5);
    throw new AutomicApiError(
      'invalid_response',
      200,
      `Automic API returned an unexpected structure on ${method} ${this.#pathOf(path)} (fields: ${fields.join(', ')})`,
    );
  }

  #pathOf(path: string): string {
    return new URL(this.#baseUrl + path).pathname;
  }

  async #request(method: 'GET' | 'POST', path: string, options: RequestOptions): Promise<unknown> {
    const url = new URL(this.#baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined) continue;
      url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
    const where = `${method} ${url.pathname}`;
    const headers: Record<string, string> = { authorization: this.#authorization, accept: 'application/json' };
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    // One signal bounds the whole exchange: connection, headers and body.
    const signal = AbortSignal.timeout(this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers,
        body: options.body === undefined ? null : JSON.stringify(options.body),
        redirect: 'manual',
        signal,
      });
    } catch (err) {
      throw this.#transportError(err, where);
    }

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new AutomicApiError(
        'redirect',
        response.status,
        `Automic API redirect ${response.status} refused on ${where}`,
      );
    }

    let text: string;
    try {
      text = await readLimited(response, this.#maxBytes);
    } catch (err) {
      // Headers were received: keep their status, the failure happened while reading the body.
      const failure = err instanceof AutomicApiError ? err : this.#transportError(err, where);
      const message = err instanceof AutomicApiError ? `${err.message} on ${where}` : failure.message;
      throw new AutomicApiError(failure.kind, response.status, message);
    }

    if (!response.ok) throw this.#httpError(response.status, text, where);
    if (text.trim() === '') {
      if (options.allowEmpty) return undefined;
      throw new AutomicApiError('invalid_response', response.status, `Automic API returned an empty body on ${where}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new AutomicApiError(
        'invalid_response',
        response.status,
        `Automic API returned a non-JSON body on ${where}`,
      );
    }
  }

  #transportError(err: unknown, where: string): AutomicApiError {
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return new AutomicApiError('timeout', 0, `Automic API timeout after ${this.#timeoutMs} ms on ${where}`);
    }
    // Only a short system code is reported: raw messages may embed URLs or credentials.
    const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
    const safeCode = typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code) ? code : undefined;
    if (safeCode !== undefined && UNREACHABLE_CODES.has(safeCode)) {
      return new AutomicApiError('unreachable', 0, `Automic API unreachable (${safeCode}) on ${where}`);
    }
    return new AutomicApiError(
      'network',
      0,
      `Automic API network error${safeCode ? ` (${safeCode})` : ''} on ${where}`,
    );
  }

  #httpError(status: number, text: string, where: string): AutomicApiError {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    const single = OutError.safeParse(json);
    const list = OutValidationErrors.safeParse(json);
    // Redact each server text BEFORE clipping it: a clip could cut a secret in half and the
    // remaining prefix would no longer match the known secret.
    const safe = (raw: string, max: number) => clip(this.#redact.text(raw), max);
    let reason = `HTTP ${status}`;
    let code: number | undefined;
    if (single.success) {
      code = single.data.code;
      const details = single.data.details;
      const extra = details && details !== DEFAULT_DETAILS ? ` — ${safe(details, 200)}` : '';
      reason = `${safe(single.data.error, 200)}${code === undefined ? '' : ` (code ${code})`}${extra}`;
    } else if (list.success && list.data.length > 0) {
      reason = list.data
        .slice(0, 3)
        .map((item) => safe(item.error, 120))
        .join('; ');
    }
    return new AutomicApiError('http', status, `Automic API ${status} on ${where}: ${reason}`, code);
  }
}

/** Base64 of `CLIENT/USER/DEPARTMENT:PASSWORD` (UTF-8), as expected by the AE REST API. */
export function basicToken(config: AutomicConfig): string {
  const userPass = `${config.client}/${config.user}/${config.department}:${config.password}`;
  return Buffer.from(userPass, 'utf8').toString('base64');
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new AutomicApiError('too_large', response.status, `Automic API response exceeds ${maxBytes} bytes`);
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new AutomicApiError('too_large', response.status, `Automic API response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
