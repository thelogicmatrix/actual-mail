// redact.js is the tool a contributor runs over their own bank mail before opening a PR.
// A silent regression here leaks a stranger's account number into a public repo, so the
// two moving parts — loading the rules and applying them — are covered directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyLiterals, loadLiterals, shiftDates } from '../scripts/redact.js';

// Written as a product, never as a literal: milliseconds-per-day is eight digits starting with
// an 8, which the PII gate reads as a Singapore phone number. redact.js says the same about its
// own copy of this constant.
const DAY = 24 * 60 * 60 * 1000;

test('applies a literal rule', () => {
  const rules = [[/Nathan/gi, 'testuser']];
  assert.equal(applyLiterals('sent by Nathan today', rules), 'sent by testuser today');
});

// The second replacement differs from what it matches on purpose. An identity substitution
// here would pass whether or not the rules ran in order, which is no test at all.
test('applies rules in order, so a later rule sees the earlier substitution', () => {
  const rules = [[/Savings Pot/g, 'TEST POT'], [/TEST POT/g, 'TEST POT 2']];
  assert.equal(applyLiterals('moved to Savings Pot', rules), 'moved to TEST POT 2');
});

// String.replace reads the replacement as a substitution pattern, so an unescaped `$&` would
// re-insert the very text being redacted. The redactor putting the PII back is the worst
// failure this file has.
test('a $ in a replacement is literal, never a back-reference', () => {
  const rules = [[/Jane Doe/g, 'TEST ($&)']];
  assert.equal(applyLiterals('paid Jane Doe', rules), 'paid TEST ($&)');
});

test('no rules is a no-op, not a crash', () => {
  assert.equal(applyLiterals('unchanged text', []), 'unchanged text');
});

// The state every contributor starts in. Empty array, not undefined and not a throw:
// a missing private.local.json means structural redaction only, which still has to run.
test('a missing private.local.json yields no rules rather than crashing', () => {
  const rules = loadLiterals(join(mkdtempSync(join(tmpdir(), 'redact-')), 'private.local.json'));
  assert.deepEqual(rules, []);
  assert.equal(applyLiterals('untouched', rules), 'untouched');
});

test('loads pattern, flags and replacement from the file', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'redact-')), 'private.local.json');
  writeFileSync(path, JSON.stringify({
    literals: [{ pattern: 'Some Pot', flags: 'gi', replacement: 'TEST POT' }],
  }));
  assert.equal(applyLiterals('moved to some pot twice: Some Pot', loadLiterals(path)),
    'moved to TEST POT twice: TEST POT');
});

// Without 'g' a rule replaces only the first occurrence and the second copy of the
// contributor's name ships. Both the absent and the present-but-non-global case: a bare
// `flags || 'g'` fallback covers the first and silently misses the second.
test('flags default to global', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'redact-')), 'private.local.json');
  writeFileSync(path, JSON.stringify({ literals: [{ pattern: 'Name', replacement: 'X' }] }));
  assert.equal(applyLiterals('Name and Name', loadLiterals(path)), 'X and X');
});

test('a non-global flags value still gets global, not just the first occurrence', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'redact-')), 'private.local.json');
  writeFileSync(path, JSON.stringify({
    literals: [{ pattern: 'Jane Doe', flags: 'i', replacement: 'TEST USER' }],
  }));
  const rules = loadLiterals(path);
  assert.equal(rules[0][0].global, true);
  assert.equal(rules[0][0].ignoreCase, true, 'the declared flag survives, g is added not swapped');
  assert.equal(applyLiterals('Jane Doe paid jane doe', rules), 'TEST USER paid TEST USER');
});

// shiftDates moves a fixture's timestamps off the maintainer's real ones. A timestamp of when a
// named person transacted is identifying even when the amount beside it is fake, and the
// fixtures ship publicly. The parser is tested against this bank's exact rendering, so the shift
// has to move the VALUES and leave the FORMAT byte-identical — every test below is about that
// seam, because a shift that reformats breaks the parser the fixtures exist to test.

// This bank writes "3 Feb" in one template and "05 Feb" in another, and both are parsed.
// Re-padding to a fixed width would silently retire one of those cases.
test('day padding keeps its original width in both directions', () => {
  assert.match(shiftDates('3 Feb 2026 10:00', -1 * DAY), /^2 Feb 2026 10:00$/);
  assert.match(shiftDates('05 Feb 2026 10:00', -1 * DAY), /^04 Feb 2026 10:00$/);
});

// The offset carries a minutes component, so a shift can cross midnight. UTC arithmetic on
// purpose: the bank's own offset is a literal suffix in the text and is not being moved, so a
// local-time Date would silently add the host's zone on top.
test('a shift across midnight rolls the date, not just the clock', () => {
  assert.equal(shiftDates('3 Feb 2026 00:30', -1 * 60 * 60 * 1000), '2 Feb 2026 23:30');
});

test('a date with no time is shifted and stays timeless', () => {
  assert.equal(shiftDates('12 Feb 2026', -1 * DAY), '11 Feb 2026');
});

// Uniformity is the point. Shifting each date independently would scramble the intervals
// between them, and two fixtures that describe the same transaction pair would stop agreeing.
// Note the asymmetry, which is the padding rule doing its job: "3 Feb" was written one
// character wide and becomes "24 Jan" because padStart never truncates, while "13 Mar" was
// written two wide and becomes "03 Mar" rather than "3 Mar".
test('every date in one run moves by the same delta', () => {
  const out = shiftDates('3 Feb 2026 10:00 and 13 Mar 2026 10:00', -10 * DAY);
  assert.equal(out, '24 Jan 2026 10:00 and 03 Mar 2026 10:00');
});

// The gap before the time is part of the rendering: this bank emits both "07:24SGT" and
// "12:33 SGT", and the parser is tested against both spacings.
test('the spacing between date and time survives byte for byte', () => {
  assert.equal(shiftDates('3 Feb 2026   10:00', -1 * DAY), '2 Feb 2026   10:00');
});

// A bare year is not a date. Rewriting it would corrupt prose and, worse, code.
test('a four-digit year on its own is not treated as a date', () => {
  assert.equal(shiftDates('the 2026 release', -400 * DAY), 'the 2026 release');
});
