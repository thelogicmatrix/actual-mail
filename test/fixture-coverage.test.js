import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import parsers from '../src/parsers/index.js';

// The rule that makes a contributed bank evidenced rather than trusted: the maintainer never
// receives that bank's mail, so the redacted fixture is the only thing that can verify the
// parser, and the only thing that fails when the bank changes its template.
//
// Keyed on the parser ID, not on the `source` it emits. trust-sg deliberately emits
// source: 'trust' to keep rowId() and Actual's imported_id stable, so source is not a
// directory name and never will be.
//
// Resolved against import.meta.url, not cwd, because a cwd-relative path makes this gate
// vacuous the moment it runs from anywhere but the repo root (existsSync would be false and
// the assert would fire for the wrong reason; readdirSync of a missing dir would throw).
//
// Only the registry is checked. `wise` is an API source hardcoded in cli.js, not a parser
// here — it has no mail template to break, so demanding a mail fixture from it would be a
// rule someone deletes rather than satisfies.
test('every registered parser has at least one fixture', () => {
  for (const p of parsers) {
    const dir = new URL(`./fixtures/${p.id}/`, import.meta.url);
    assert.ok(existsSync(dir), `${p.id} has no fixture directory at test/fixtures/${p.id}`);
    const fixtures = readdirSync(dir).filter((f) => f.endsWith('.txt'));
    assert.ok(fixtures.length > 0, `${p.id} has a fixture directory but no .txt fixtures`);
  }
});
