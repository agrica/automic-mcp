import { describe, expect, it } from 'vitest';
import { checkContinuation } from '../../src/recette/continuation.js';

const reference = [105, 104, 103, 102, 101];

describe('checkContinuation', () => {
  it('accepts every item exactly once, the oldest included, with an empty last page', () => {
    expect(checkContinuation(reference, [[105, 104], [103, 102], [101], []], [104, 102, 101])).toEqual({
      ok: true,
      missing: [],
      duplicates: [],
      unexpected: [],
      emptyPages: [],
      stalledPages: [],
      cursorMismatches: [],
    });
  });

  it('reports the oldest item lost by a "RunID >" cursor on a descending list', () => {
    // Cursor = max RunID of the page on a list sorted descending: the second request repeats nothing new.
    const report = checkContinuation(
      reference,
      [
        [105, 104],
        [105, 104],
      ],
      [105],
    );
    expect(report).toMatchObject({
      ok: false,
      missing: [101, 102, 103],
      duplicates: [104, 105],
      stalledPages: [1],
      cursorMismatches: [0],
    });
  });

  it('follows the documented rule: the cursor is the LAST item returned, not the minimum', () => {
    // Sorted by activation then RunID: page 1 ends with 105, its minimum is 101.
    const known = [101, 105, 103, 104];
    const pages = [
      [101, 105],
      [103, 104],
    ];
    expect(checkContinuation(known, pages, [105]).ok).toBe(true);
    expect(checkContinuation(known, pages, [101])).toMatchObject({ ok: false, cursorMismatches: [0] });
    expect(checkContinuation(known, pages, [])).toMatchObject({ ok: false, cursorMismatches: [0] });
  });

  it('reports an empty page in the middle and items outside the known set', () => {
    const report = checkContinuation(reference, [[105, 104, 103], [], [102, 101, 99]], [103, 103]);
    expect(report).toMatchObject({ ok: false, emptyPages: [1], unexpected: [99], missing: [] });
  });

  it('reports items missing when the paging stops early', () => {
    expect(checkContinuation(reference, [[105, 104], []], [104]).missing).toEqual([101, 102, 103]);
  });
});
