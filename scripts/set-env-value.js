// Dev tool. Replaces one KEY=... line in .env with a value read from stdin, so the value
// never appears in a shell argument, a log, or a terminal.
//   <source of value> | node scripts/set-env-value.js ACTUAL_BUDGET_PASSWORD
import { readFileSync, writeFileSync } from 'node:fs';

const key = process.argv[2];
if (!key) throw new Error('usage: set-env-value.js <KEY>  (value on stdin)');

const value = readFileSync(0, 'utf8').trim();
if (!value) throw new Error('empty value on stdin');

const file = new URL('../.env', import.meta.url);
const src = readFileSync(file, 'utf8');
const line = new RegExp(`^${key}=.*$`, 'm');
if (!line.test(src)) throw new Error(`${key} not present in .env`);

// Single-quote it. Node's --env-file parser treats an unquoted `#` as a comment and
// silently truncates the value there — a 32-char password arrived as 7 chars and read as
// a wrong secret for a whole session.
if (value.includes("'")) throw new Error(`${key} contains a single quote; quote it by hand`);

writeFileSync(file, src.replace(line, `${key}='${value}'`));
console.log(`${key} set (${value.length} chars, single-quoted)`);
