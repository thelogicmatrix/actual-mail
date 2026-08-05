import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTrust } from '../src/parsers/trust-sg.js';

// Fixtures hold the decoded body text, which is exactly what parseTrust receives.
const fixture = (name) =>
  readFileSync(new URL(`./fixtures/trust-sg/${name}.txt`, import.meta.url), 'utf8').trim();

test('domestic card spend is negative', () => {
  const row = parseTrust(fixture('card'), '<r1>', 'Yay! Transaction successful');
  assert.equal(row.type, 'card');
  assert.equal(row.currency, 'SGD');
  assert.equal(row.amount, '-12.34');
  assert.equal(row.payee, 'TEST MERCHANT SG');
  assert.match(row.date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/);
});

test('overseas spend billed in SGD parses despite the swapped clause order', () => {
  const row = parseTrust(fixture('card-overseas-sgd'), '<r2>', 'Yay! Overseas transaction successful');
  assert.equal(row.type, 'card');
  assert.equal(row.currency, 'SGD');
  assert.equal(row.amount, '-23.45');
  assert.equal(row.payee, 'TEST MERCHANT US');
});

test('overseas FX spend keeps the foreign currency, never assumes SGD', () => {
  const row = parseTrust(fixture('fx-card'), '<r3>', 'Yay! Overseas transaction successful');
  assert.equal(row.type, 'card');
  assert.equal(row.currency, 'GBP');
  assert.equal(row.amount, '-34.56');
  assert.equal(row.payee, 'TEST MERCHANT GB');
});

test('the GMT+08:00 timezone rendering parses', () => {
  const row = parseTrust(fixture('card-overseas-gmt'), '<r4>', 'Yay! Overseas transaction successful');
  assert.ok(row, 'GMT+08:00 variant must not fall through to UNPARSED');
  assert.equal(row.amount, '-99.99');
  // Shape, not value. Fixture dates carry a per-run offset applied when they are regenerated
  // (redact.js), so pinning the literal would break on every regeneration. What this test is
  // about is the `+08:00` tail: that the bank's "GMT+08:00" rendering parses to the same offset
  // as its usual "SGT" one.
  assert.match(row.date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/);
});

test('paynow out is negative and carries the source account', () => {
  const row = parseTrust(fixture('paynow-out'), '<r5>', "Yay! Your Paynow transfer's a success.");
  assert.equal(row.type, 'transfer_out');
  assert.equal(row.account, '0000');
  assert.equal(row.amount, '-45.67');
  assert.equal(row.payee, 'TEST COUNTERPARTY');
});

test('paynow in is positive', () => {
  const row = parseTrust(fixture('paynow-in'), '<r6>', "Yay! You've received a PayNow transfer.");
  assert.equal(row.type, 'transfer_in');
  assert.equal(row.amount, '56.78');
  assert.equal(row.payee, 'TEST COUNTERPARTY');
});

test('KACHING inbound transfer is positive', () => {
  const row = parseTrust(fixture('kaching-in'), '<r7>', "KACHING. You've got a transfer");
  assert.equal(row.type, 'transfer_in');
  assert.equal(row.amount, '67.89');
});

test('local transfer out is negative and keeps source and destination distinct', () => {
  const row = parseTrust(fixture('local-out'), '<r8>', "Success! You've made a local transfer.");
  assert.equal(row.type, 'transfer_out');
  assert.equal(row.account, '0000');
  assert.equal(row.amount, '-78.90');
  // Both accounts render `ending 0000` — the redactor zeroes every digit run, and the gate
  // allows no other form. The TEST BANK prefix is what proves the parser did not read the
  // source account as the payee.
  assert.equal(row.payee, 'TEST BANK A/C ending 0000');
});

test('pot transfer parses the S$ rendering', () => {
  const row = parseTrust(fixture('pot-transfer'), '<r9>', 'Yay! Your Savings Pot transfer is successful');
  assert.equal(row.type, 'pot_transfer');
  assert.equal(row.currency, 'SGD');
  assert.equal(row.amount, '-89.01');
  assert.equal(row.payee, 'TEST POT');
});

test('cancellation is POSITIVE so it offsets the original spend', () => {
  const row = parseTrust(fixture('cancel'), '<r10>', 'Transaction cancelled');
  assert.equal(row.type, 'cancel');
  assert.equal(row.amount, '90.12');
});

test('FX cancellation keeps its foreign currency', () => {
  const row = parseTrust(fixture('fx-cancel'), '<r11>', 'Overseas transaction cancelled');
  assert.equal(row.type, 'cancel');
  assert.equal(row.currency, 'USD');
  assert.equal(row.amount, '11.22');
});

test('refund is positive', () => {
  const row = parseTrust(fixture('refund'), '<r12>', 'Ta-da! Transaction refunded');
  assert.equal(row.type, 'refund');
  assert.equal(row.amount, '22.33');
});

test('overseas refund is positive and comes back in SGD', () => {
  const row = parseTrust(fixture('fx-refund'), '<r13>', 'Ta-da! Overseas transaction refunded');
  assert.equal(row.type, 'refund');
  assert.equal(row.currency, 'SGD');
  assert.equal(row.amount, '13.44');
});

test('a non-transactional notice is ignored, not unparsed', () => {
  const r = parseTrust(fixture('ignore-payee-added'), '<r14>', 'New payee successfully added');
  assert.equal(r.ignored, true);
});

test('an eStatement notice is ignored', () => {
  const r = parseTrust(fixture('ignore-estatement'), '<r15>', 'Sweet! Your savings account eStatement is ready');
  assert.equal(r.ignored, true);
});

test('marketing mail with a dollar figure but no parser match is ignored by subject', () => {
  const r = parseTrust('Enjoy up to S$600.00 in cash rebates on your bills', '<r16>',
    '<ADV>Enjoy up to S$600 in cash rebates');
  assert.equal(r.ignored, true);
});

test('a money-bearing body with an unknown shape is REPORTED, not dropped', () => {
  assert.equal(parseTrust('You have transacted SGD 5.00 somehow new', '<r17>',
    'Yay! Some brand new alert'), null);
});

test('thousands separators are stripped', () => {
  const row = parseTrust(
    "You've spent SGD 1,234.50 at X SG on 1 Jan 2026 10:00 SGT with Trust Link card",
    '<r18>', 'Yay! Transaction successful');
  assert.equal(row.amount, '-1234.50');
});

test('a curly apostrophe parses', () => {
  const row = parseTrust(
    'You’ve spent SGD 2.00 at Y SG on 1 Jan 2026 10:00 SGT with Trust Link card',
    '<r19>', 'Yay! Transaction successful');
  assert.equal(row.amount, '-2.00');
});

// The ON in this placeholder is the whole point — it is the " on " the date pattern must NOT
// stop at. Keep it when renaming; TEST SHOP SG would leave the test asserting nothing.
test('a merchant name containing " on " does not truncate the payee', () => {
  const row = parseTrust(
    "You've spent SGD 3.00 at TEST ON SG on 1 Jan 2026 10:00 SGT with Trust Link card",
    '<r20>', 'Yay! Transaction successful');
  assert.equal(row.payee, 'TEST ON SG');
});

test('row ids are derived from the ref, so the same message always yields the same id', () => {
  const a = parseTrust(fixture('card'), '<same>', 'Yay! Transaction successful');
  const b = parseTrust(fixture('card'), '<same>', 'Yay! Transaction successful');
  assert.equal(a.id, b.id);
});

// --- Variants found by running the parser over all 439 live messages (2026-07-28).
// Strings are the real observed sentences with identifiers replaced.

test('pot transfer in the reverse direction (pot -> account) is positive', () => {
  const row = parseTrust(
    'Your Own Account Transfer of S$ 400.00 from TEST POT to A/C ending 0000 on 22 May 2026 16:00 SGT is successful.',
    '<v1>', 'Yay! Your Savings Pot transfer is successful');
  assert.equal(row.type, 'pot_transfer');
  assert.equal(row.account, '0000', 'account is always the bank account, never the pot');
  assert.equal(row.payee, 'TEST POT');
  assert.equal(row.amount, '400.00');
});

test('a pot transfer pair nets to zero', () => {
  const out = parseTrust(
    'Your Own Account Transfer of S$ 50.00 from A/C ending 0000 to TEST POT on 1 Jan 2026 10:00 SGT is successful.',
    '<v2>', 'pot');
  const back = parseTrust(
    'Your Own Account Transfer of S$ 50.00 from TEST POT to A/C ending 0000 on 2 Jan 2026 10:00 SGT is successful.',
    '<v3>', 'pot');
  assert.equal(Number(out.amount) + Number(back.amount), 0);
});

test('inbound local transfer is positive', () => {
  const row = parseTrust(
    "🎉 You've received a local transfer of SGD 9.29 from TEST COUNTERPARTY PTE. LTD on 7 Jun 2026 18:12 SGT.",
    '<v4>', "Success! You've received a local transfer.");
  assert.equal(row.type, 'transfer_in');
  assert.equal(row.amount, '9.29');
  assert.equal(row.payee, 'TEST COUNTERPARTY PTE. LTD',
    'a period inside the payee must not truncate it');
});

test('the card is named "Trust card" on some messages and "Trust Link card" on others', () => {
  const plain = parseTrust(
    "You've spent SGD 4.09 at TEST MERCHANT SG on 7 Jun 2026 18:12SGT with Trust card.",
    '<v5>', 'Yay! Transaction successful');
  const link = parseTrust(
    "You've spent SGD 4.09 at TEST MERCHANT SG on 7 Jun 2026 18:12SGT with Trust Link card.",
    '<v6>', 'Yay! Transaction successful');
  assert.equal(plain.amount, '-4.09');
  assert.equal(link.amount, '-4.09');
});
