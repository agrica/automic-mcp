import { json } from './fetch.js';

/**
 * Simulated report servers for the three readings of start_at (H3). They are test doubles, not a model
 * of the real instance: the instance's behaviour is recorded in acceptance (task 11).
 * - exclusive: start_at=k returns pages k+1, k+2... (spec 24.4 wording), start_at=0 gives page 1;
 * - inclusive: start_at=k returns pages k, k+1... (older documentation), start_at=0 read as 1;
 * - inclusive-refusing-zero: like inclusive, but start_at=0 is answered with a 400.
 */
export type ReportConvention = 'exclusive' | 'inclusive' | 'inclusive-refusing-zero';

export function reportServer(total: number, convention: ReportConvention) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.search);
    const startAt = Number(url.searchParams.get('start_at') ?? 1);
    const max = Number(url.searchParams.get('max_results') ?? 1);
    if (convention === 'inclusive-refusing-zero' && startAt === 0) {
      return json({ code: 1, error: 'Invalid value for start_at' }, 400);
    }
    const from = convention === 'exclusive' ? startAt + 1 : Math.max(1, startAt);
    const data = [];
    for (let page = from; page < from + max && page <= total; page++) data.push({ page, content: `p${page}\n` });
    return json({ total, data });
  };
  return { fetch: fetchImpl, calls };
}
