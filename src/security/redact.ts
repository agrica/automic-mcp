const MASK = '***';
const SECRET_NAME = /pass(word|wd)?|pwd|secret|token|credential|private[_-]?key|api[_-]?key/i;
const VALUE_FIELD = /^value\d*$/i;
const LABEL_FIELDS = ['key', 'name', 'variable', 'variable_name'];

export interface Redactor {
  /**
   * Two layers, with different guarantees:
   * 1. known secrets (configured password, Basic token, user:password): every occurrence is masked,
   *    whatever its length, in values AND in property names — this is the only promise of confidentiality;
   * 2. heuristics (Basic/Bearer tokens, URL credentials, `password=...` pairs, the keyword may sit inside an identifier: `DB_PASSWORD=`, `&DB_PASSWORD# =`): best effort for
   *    secrets the server does not know; an unknown secret without a recognizable shape passes.
   */
  text(value: string): string;
  /**
   * Deep copy: the whole subtree of a secret-looking key is masked, every other string goes through `text`.
   * Property names go through `text` too; a masked name that collides with another one gets a `#2`, `#3`... suffix.
   * A number whose decimal form contains a known secret becomes `***` (secret 1234, RunID 51234): numbers
   * are data like strings, and an audit line or a result must not print the secret through them.
   */
  value(value: unknown): unknown;
  /** Last line of defence on serialized output: true if a known secret (raw or JSON-escaped) is still present. */
  leaks(serialized: string): boolean;
}

export function createRedactor(secrets: readonly string[]): Redactor {
  // Every non-empty secret, longest first, so that a secret containing another one is masked whole.
  const known = [...new Set(secrets.filter((secret) => secret.length > 0))].sort((a, b) => b.length - a.length);
  // A secret containing `"`, `\` or a control character appears escaped once serialized to JSON.
  const forms = [...new Set(known.flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)]))];

  const text = (input: string): string => {
    let output = input;
    for (const secret of known) output = output.split(secret).join(MASK);
    return output
      .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/=._-]{8,}/gi, `$1 ${MASK}`)
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${MASK}@`)
      .replace(
        /((?:password|passwd|pwd|secret|token|api[_-]?key)[\w#$]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&"']+)/gi,
        `$1$2${MASK}`,
      );
  };

  const value = (input: unknown): unknown => {
    if (typeof input === 'string') return text(input);
    if (typeof input === 'number' || typeof input === 'bigint') {
      const digits = String(input);
      return known.some((secret) => digits.includes(secret)) ? MASK : input;
    }
    if (Array.isArray(input)) return input.map(value);
    if (input === null || typeof input !== 'object') return input;
    const record = input as Record<string, unknown>;
    // VARA-like rows: {key: 'DB_PASSWORD', value1: '...'} -> mask the value fields.
    const labelledSecret = LABEL_FIELDS.some((field) => {
      const label = record[field];
      return typeof label === 'string' && SECRET_NAME.test(label);
    });
    const copy: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) {
      const masked = child !== null && (SECRET_NAME.test(key) || (labelledSecret && VALUE_FIELD.test(key)));
      const safeKey = text(key);
      let name = safeKey;
      for (let n = 2; Object.hasOwn(copy, name); n++) name = `${safeKey}#${n}`;
      copy[name] = masked ? MASK : value(child);
    }
    return copy;
  };

  const leaks = (serialized: string): boolean => forms.some((form) => serialized.includes(form));

  return { text, value, leaks };
}

/** Caps a message for tool output; `max` counts characters of the returned string. Redact first, then clip. */
export function clip(text: string, max = 500): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
