// Acceptance run H4/H8: node scripts/check-continuation.mjs capture.json  (after npm run build)
// capture.json = {"reference": [RunIDs of the known set],
//                 "pages": [[RunIDs of request 1, in the order returned], [request 2], ...],
//                 "cursors": [start_at_run_id sent for request 2, for request 3, ...]}
import { readFileSync } from 'node:fs';
import { checkContinuation } from '../dist/recette/continuation.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/check-continuation.mjs capture.json');
  process.exit(2);
}
const { reference, pages, cursors } = JSON.parse(readFileSync(file, 'utf8'));
const report = checkContinuation(reference, pages, cursors ?? []);
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
