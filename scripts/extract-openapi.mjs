// Extracts the AE REST OpenAPI document embedded in the Broadcom TechDocs page.
// Usage: node scripts/extract-openapi.mjs <saved-page.html> <out.json>
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error('usage: node scripts/extract-openapi.mjs <page.html> <out.json>');
  process.exit(2);
}
const html = readFileSync(input, 'utf8');
const marker = 'bc-open-api-json" class="pre codeblock">';
const at = html.indexOf(marker);
if (at < 0) throw new Error('OpenAPI block not found');
let block = html.slice(html.indexOf('{', at));
// The page injects raw HTML (attr="x") inside JSON strings: turn attribute quotes into single quotes.
for (let previous; previous !== block; ) {
  previous = block;
  block = block.replace(/(<[a-zA-Z][^<>]*?\s[\w-]+)="([^"<>]*)"/g, "$1='$2'");
}
const named = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&', nbsp: ' ' };
block = block.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
  if (entity[0] !== '#') return named[entity.toLowerCase()] ?? match;
  const code = entity[1] === 'x' || entity[1] === 'X' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
  return String.fromCodePoint(code);
});
// Keep only the first complete JSON value; the HTML that follows is ignored.
let depth = 0;
let inString = false;
let escaped = false;
let end = -1;
for (let i = 0; i < block.length && end < 0; i++) {
  const c = block[i];
  if (inString) {
    if (escaped) escaped = false;
    else if (c === '\\') escaped = true;
    else if (c === '"') inString = false;
  } else if (c === '"') inString = true;
  else if (c === '{') depth++;
  else if (c === '}' && --depth === 0) end = i + 1;
}
if (end < 0) throw new Error('Unterminated OpenAPI block');
const spec = JSON.parse(block.slice(0, end));
const text = `${JSON.stringify(spec, null, 2)}\n`;
writeFileSync(output, text);
const verbs = ['get', 'post', 'put', 'patch', 'delete'];
const operations = Object.values(spec.paths).flatMap((item) => Object.keys(item).filter((k) => verbs.includes(k)));
const sha256 = createHash('sha256').update(text).digest('hex');
console.log(`openapi=${spec.openapi} version=${spec.info.version} operations=${operations.length} sha256=${sha256}`);
