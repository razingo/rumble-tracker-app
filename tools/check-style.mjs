// Checks the source files against .editorconfig: lines of at most 140 characters, LF line endings, no tabs or
// trailing spaces, and a final newline. Markdown is left out. Usage: npm run check-style
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { GIT } from './git.mjs';

const MAX = 140;
const CHECKED = /^(\.github|desktop|server|test|tools|web)\/.*\.(m?js|cjs|css|html|ps1|ya?ml)$/;

const files = execFileSync(GIT, ['ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n').filter((f) => CHECKED.test(f));
const problems = [];
for (const f of files) {
  let text;
  // deleted but not yet staged
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\r')) problems.push(`${f}: CRLF line endings`);
  if (text && !text.endsWith('\n')) problems.push(`${f}: no newline at the end`);
  text.split('\n').forEach((line, i) => {
    const where = `${f}:${i + 1}`;
    if ([...line].length > MAX) problems.push(`${where}: ${[...line].length} characters`);
    if (line.includes('\t')) problems.push(`${where}: tab`);
    if (/[ \t]+$/.test(line)) problems.push(`${where}: trailing spaces`);
  });
}
for (const p of problems) console.log(p);
console.log(problems.length ? `${problems.length} problems in ${files.length} files` : `${files.length} files checked`);
process.exitCode = problems.length ? 1 : 0;
