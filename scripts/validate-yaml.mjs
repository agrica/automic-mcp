// Parses YAML files strictly (syntax, duplicate keys). Semantic checks of workflows run in CI with actionlint.
// Usage: node scripts/validate-yaml.mjs <file.yml>...
import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';

let failed = false;
for (const file of process.argv.slice(2)) {
  const document = parseDocument(readFileSync(file, 'utf8'), { uniqueKeys: true, prettyErrors: true });
  const problems = [...document.errors, ...document.warnings];
  if (problems.length > 0 || document.contents === null) {
    failed = true;
    console.error(`${file}: invalid`);
    for (const problem of problems) console.error(`  ${problem.message}`);
  } else {
    console.log(`${file}: ok`);
  }
}
process.exit(failed ? 1 : 0);
