/**
 * Acceptance helper (not used by the server): checks a candidate paging rule on captured pages.
 * `reference` = the RunIDs of a known set (AWI export or verified capture);
 * `pages` = the RunIDs returned by each successive request, IN THE ORDER RETURNED (never re-sorted);
 * `cursors` = the start_at_run_id sent for requests 2, 3... (cursors[i] follows pages[i]).
 * Documented rule: the cursor is the RunID of the LAST item returned. The list is sorted by activation
 * time then RunID, so the last item is not necessarily the minimum or the maximum of its page.
 * A rule is acceptable only if every reference item comes back exactly once, oldest included, and
 * every cursor sent is the last item of the previous page.
 */
export interface ContinuationReport {
  ok: boolean;
  missing: number[];
  duplicates: number[];
  unexpected: number[];
  /** Indexes of empty pages that are not the last page (an empty last page ends the paging). */
  emptyPages: number[];
  /** Indexes of non-empty pages that brought no new item (the cursor did not move). */
  stalledPages: number[];
  /** Indexes i where cursors[i] is missing or differs from the last item of pages[i]. */
  cursorMismatches: number[];
}

export function checkContinuation(
  reference: readonly number[],
  pages: readonly (readonly number[])[],
  cursors: readonly number[],
): ContinuationReport {
  const expected = new Set(reference);
  const seen = new Set<number>();
  const duplicates = new Set<number>();
  const unexpected = new Set<number>();
  const emptyPages: number[] = [];
  const stalledPages: number[] = [];
  pages.forEach((page, index) => {
    if (page.length === 0) {
      if (index < pages.length - 1) emptyPages.push(index);
      return;
    }
    let progressed = false;
    for (const item of page) {
      if (seen.has(item)) duplicates.add(item);
      else {
        seen.add(item);
        progressed = true;
      }
      if (!expected.has(item)) unexpected.add(item);
    }
    if (!progressed) stalledPages.push(index);
  });
  const cursorMismatches: number[] = [];
  for (let index = 0; index < pages.length - 1; index++) {
    if (cursors[index] === undefined || cursors[index] !== pages[index]?.at(-1)) cursorMismatches.push(index);
  }
  const missing = [...expected].filter((item) => !seen.has(item));
  const sorted = (items: Iterable<number>) => [...items].sort((a, b) => a - b);
  const report = {
    missing: sorted(missing),
    duplicates: sorted(duplicates),
    unexpected: sorted(unexpected),
    emptyPages,
    stalledPages,
    cursorMismatches,
  };
  const ok = Object.values(report).every((list) => list.length === 0);
  return { ok, ...report };
}
