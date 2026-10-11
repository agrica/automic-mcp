/**
 * - http: Automic answered with an error status (4xx: refused, 5xx: outcome unknown)
 * - unreachable: connection never established (refused, DNS) -> request not processed
 * - network / timeout: failure after the request may have been sent -> outcome unknown
 * - redirect: a 3xx was refused by policy
 * - too_large / invalid_response: the answer could not be used -> outcome unknown for writes
 */
export type FailureKind =
  | 'http'
  | 'unreachable'
  | 'network'
  | 'timeout'
  | 'redirect'
  | 'too_large'
  | 'invalid_response';

export class AutomicApiError extends Error {
  override name = 'AutomicApiError';

  constructor(
    readonly kind: FailureKind,
    readonly status: number,
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }

  /** True when a write may or may not have been applied by Automic. */
  get outcomeUnknown(): boolean {
    if (this.kind === 'unreachable') return false;
    if (this.kind === 'http') return this.status >= 500;
    return true;
  }
}

/** Input or policy error raised by the tools themselves, before any HTTP request. */
export class ToolInputError extends Error {
  override name = 'ToolInputError';
}

/** A write whose effect is unknown (timeout, network, 5xx, unreadable answer). Never retried automatically. */
export class WriteOutcomeUnknownError extends Error {
  override name = 'WriteOutcomeUnknownError';
}
