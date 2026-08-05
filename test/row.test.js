import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { makeRow, rowId } from '../src/row.js';

test('rowId is deterministic for the same source and ref', () => {
  const a = rowId('trust', '<abc@example.com>');
  const b = rowId('trust', '<abc@example.com>');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('rowId differs across sources for the same ref', () => {
  assert.notEqual(rowId('trust', 'x'), rowId('wise', 'x'));
});

test('makeRow builds the full row shape with a derived id', () => {
  const row = makeRow({
    source: 'trust', account: '0000', date: '2026-07-28T07:24:00+08:00',
    amount: '-3.18', currency: 'SGD', payee: 'TEST MERCHANT SG',
    type: 'card', rawRef: '<abc@example.com>',
  });
  assert.equal(row.id, rowId('trust', '<abc@example.com>', '0000'));
  assert.equal(row.amount, '-3.18');
  assert.equal(row.raw_ref, '<abc@example.com>');
  assert.equal(typeof row.amount, 'string');
});

test('makeRow rejects a non-string amount', () => {
  assert.throws(() => makeRow({
    source: 'trust', account: '0000', date: '2026-07-28T07:24:00+08:00',
    amount: -3.18, currency: 'SGD', payee: 'X', type: 'card', rawRef: 'r',
  }), /amount must be a string/);
});

// The separator is a NUL byte and it is invisible in most terminals, which has already caused two
// readers to report it as a space and propose "fixing" the code to match. Changing it changes every
// id, hence every Actual imported_id, hence re-imports the entire history as new spend. This test
// is here to make that change fail loudly rather than quietly cost money.
test('the row id separator is NUL, and ambiguous pairs do not collide', () => {
  assert.notEqual(rowId('a b', 'c'), rowId('a', 'b c'));
  assert.equal(rowId('trust', '<x@y>'),
    createHash('sha256').update('trust\0<x@y>').digest('hex'));
});

// The separator's VALUE is what must never move, so it is pinned to a literal rather than to
// another expression of the same code. This is the published constant in docs/WRITING-A-PARSER.md
// and the id of the row the tutorial prints, and it is the value every imported_id in the live
// budget was derived from: if this line goes red, the change re-imports the entire budget as new
// spend. Writing the separator as `\0` instead of a raw NUL byte (so git stops calling src/row.js
// binary and the file is reviewable in a diff) has to leave it exactly here.
test('the row-id separator byte is unchanged — a literal, not a restatement of the code', () => {
  assert.equal(rowId('example', '<abc123@example.com>'),
    'd37e23b173ddec24fa52a16503e80a9c0bf661ee5e80e8538f6cceee8e052a3c');
});

test('src/row.js contains no NUL byte, so git treats it as reviewable text', () => {
  // A single raw NUL made this the only tracked file git classified as binary, and
  // `git log -p -- src/row.js` answered "Binary files differ" for the most safety-critical
  // function in the tool.
  const src = readFileSync(new URL('../src/row.js', import.meta.url));
  assert.equal(src.includes(0), false, 'a raw NUL here makes the file binary to git');
});

// --- the account is part of the identity ---

test('one reference in two accounts is two rows, not one', () => {
  // A Wise balance conversion appears in BOTH balance statements under a single
  // referenceNumber. With source+ref alone the two legs shared an id, so mapping both balances
  // to one Actual account silently dropped one leg and reported `alreadyPresent: 1` — healthy.
  assert.notEqual(rowId('wise', 'REF1', 'wise-usd'), rowId('wise', 'REF1', 'wise-sgd'));
  const leg = (account) => makeRow({
    source: 'wise', account, date: '2026-07-28T07:24:00Z', amount: '-3.18',
    currency: 'SGD', payee: 'Converted', type: 'transfer_out', rawRef: 'REF1',
  }).id;
  assert.notEqual(leg('wise-usd'), leg('wise-sgd'));
});

test('the pre-account id is still derivable, which is what stops a re-import', () => {
  // loadRows checks this form against the budget as well as the current id, so rows imported
  // before the account joined the identity are recognised and never written twice. No
  // migration: their imported_id in the budget is left exactly as it is.
  assert.equal(rowId('trust', '<x@y>'), createHash('sha256').update('trust\0<x@y>').digest('hex'));
  assert.notEqual(rowId('trust', '<x@y>', 'card'), rowId('trust', '<x@y>'));
});

test('a row with no stable reference is refused, not given a shared id', () => {
  // Every Wise entry lacking a referenceNumber used to hash identically, so the first was
  // imported and the rest were counted as already-present and lost.
  for (const rawRef of [undefined, null, '']) {
    assert.throws(() => makeRow({
      source: 'wise', account: 'wise-sgd', date: '2026-07-28T07:24:00Z',
      amount: '-3.18', currency: 'SGD', payee: 'X', type: 'transfer_out', rawRef,
    }), /rawRef is required/, `rawRef ${JSON.stringify(rawRef)} must be refused`);
  }
});

// NOTE (stale doc, owned elsewhere): since the account joined the row identity, the row the
// The tutorial prints a worked row and says the parser in its section 3 produces exactly that.
// Nothing ran it, so the published id was wrong for months -- in a repo whose whole argument is
// deterministic extraction, and it is the one value a reader can check in ten seconds. This makes
// the doc's claim a runnable check instead of prose.
test('the id published in docs/WRITING-A-PARSER.md is the one the code produces', () => {
  const doc = readFileSync(new URL('../docs/WRITING-A-PARSER.md', import.meta.url), 'utf8');
  const published = doc.match(/"id": "([0-9a-f]{64})"/)?.[1];
  assert.ok(published, 'the tutorial should still print a worked row id');
  // 3-arg: the tutorial's row carries account "card", and the account is part of the identity.
  // The separator constant is pinned by its own test above and does not depend on this one.
  assert.equal(published, rowId('example', '<abc123@example.com>', 'card'));
});
