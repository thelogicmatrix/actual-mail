import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseUob } from '../src/parsers/uob-sg.js';

const fixture = (name) =>
  readFileSync(new URL(`./fixtures/uob-sg/${name}.txt`, import.meta.url), 'utf8').trim();

const REF = '<abc123@example.com>';

test('a funds transfer out is negative, on the sending account', () => {
  const row = parseUob(fixture('funds-transfer-out'), REF, 'UOB Personal Internet Banking Notification Alerts');
  assert.equal(row.source, 'uob');
  assert.equal(row.account, '0000');
  assert.equal(row.amount, '-500.00');
  assert.equal(row.currency, 'SGD');
  // The counterparty, NOT the sending account. Both are "ending 0000" after redaction, so
  // this assertion is what proves the two captures did not swap: a swap loses the prefix.
  assert.equal(row.payee, 'TEST BANK a/c ending 0000');
  assert.equal(row.type, 'transfer_out');
  assert.equal(row.date, '2026-03-24T09:34:00+08:00');
  assert.equal(row.raw_ref, REF);
});

test('a PayNow out drops the UEN suffix, so one merchant is one payee', () => {
  const row = parseUob(fixture('paynow-out'), REF, 'UOB Personal Internet Banking Notification Alerts');
  assert.equal(row.account, '0000');
  assert.equal(row.amount, '-20.00');
  assert.equal(row.payee, 'TEST MERCHANT SG');
  assert.equal(row.type, 'transfer_out');
  assert.equal(row.date, '2026-08-27T18:57:00+08:00');
});

test('a NETS QR payment is a card-like spend against the deposit account', () => {
  // Subject passed empty rather than reproduced. The real one is a finding under the
  // merchant-plus-country rule in scripts/scan-pii.js, and inventing a replacement would
  // record a subject UOB never sent as if it were evidence. Nothing is lost: the subject is
  // read only by the ignore list, which is reached only after every transaction pattern has
  // already failed.
  const row = parseUob(fixture('nets-qr'), REF, '');
  assert.equal(row.account, '0000');
  assert.equal(row.amount, '-1.50');
  assert.equal(row.payee, 'TEST MERCHANT SG');
  assert.equal(row.type, 'nets_qr');
  assert.equal(row.date, '2026-08-11T08:40:00+08:00');
});

test('an ATM withdrawal reads the trailing-timezone date form and names itself as payee', () => {
  const row = parseUob(fixture('atm'), REF, 'UOB-ATM Domestic Trns');
  assert.equal(row.account, '0000');
  assert.equal(row.amount, '-50.00');
  // No counterparty exists. A null payee would be accepted by makeRow and render blank
  // in Actual, so the literal is deliberate.
  assert.equal(row.payee, 'ATM cash withdrawal');
  assert.equal(row.type, 'atm');
  // 12:26PM is 12:26, not 00:26. The off-by-twelve is the whole point of this assertion.
  assert.equal(row.date, '2026-08-26T12:26:00+08:00');
});

// Synthetic, not a fixture. UOB has never sent a transaction between midnight and 00:59, so
// inventing a fixture would be fabricated evidence. The date helper still has to be right.
test('midnight is 00:xx, not 12:xx', () => {
  const text = 'You made a NETS QR payment of SGD 1.50 to TEST MERCHANT SG on your a/c '
    + 'ending 0000 at 12:30AM SGT, 11 Aug 26. If unauthorised, call UOB 24/7 Fraud Hotline.';
  assert.equal(parseUob(text, REF, '').date, '2026-08-11T00:30:00+08:00');
});

test('a FAST status confirmation is ignored, because it carries no amount to import', () => {
  // This mail is the bank confirming a transfer already reported WITH its amount by the
  // funds-transfer shape. Ignoring it loses nothing; parsing it is impossible.
  assert.deepEqual(
    parseUob(fixture('fast-status'), REF, 'UOB-FAST Funds Transfer Status'),
    { ignored: true, reason: 'no-money-token' });
});

test('an eStatement notice is ignored by subject', () => {
  assert.deepEqual(
    parseUob(fixture('estatement'), REF, 'Your eStatement/eAdvice is ready for viewing'),
    { ignored: true, reason: 'subject' });
});

test('the one-off card welcome notice is ignored by subject, not parsed', () => {
  // It IS a real transaction, but UOB sends exactly one per account lifetime and does not
  // alert per card spend. Its row would fall below any reconciliation floor and be counted
  // `skipped`, so parsing it buys a second mapping key and a fifth date format for nothing.
  // A future per-transaction card alert would carry a different subject, fall through to
  // null, and be reported as UNPARSED.
  const text = 'The 1st transaction of SGD 400.00 was made with your UOB Card ending 0000 '
    + 'on 26/05/26 at TEST MERCHANT SG. If unauthorised, call 24/7 Fraud Hotline';
  assert.deepEqual(
    parseUob(text, REF, 'UOB - First transaction made on your card'),
    { ignored: true, reason: 'subject' });
});

// The lowercase " on " and " from " inside the counterparty are the whole point. Both are
// substrings of the fixed account clause the pattern uses as its right-hand anchor, so this is
// what proves the lazy (.+?) stops at the real clause and not at the first lookalike inside a
// name. The failure it protects against is a maintainer widening the pattern by dropping the
// ` from your a/c ending (\d{4}) at ` tail: every other test still passes at that point, while
// payees silently absorb the account clause.
test('a counterparty name containing " on " and " from " does not truncate the payee', () => {
  const row = parseUob(
    'You made/scheduled a funds transfer(s) of SGD 100.00 to TEST COUNTERPARTY on and from SG '
    + 'from your a/c ending 0000 at 9:00AM SGT, 24 Mar 26.', REF, '');
  assert.equal(row.payee, 'TEST COUNTERPARTY on and from SG');
});

// Every fixture amount is under 1000, and so is the largest real amount in the 30-message
// sample, so nothing else exercises the comma strip. It is a live path rather than a
// hypothetical: the monthly transfers sit between 500 and 950. The failure it guards is
// `replaceAll(',', '')` being deleted as redundant, after which the loader's Number('12,345')
// is NaN and Actual is handed amount: NaN without anything throwing.
test('thousands separators are stripped', () => {
  const row = parseUob(
    'You made/scheduled a funds transfer(s) of SGD 12,345.67 to TEST COUNTERPARTY '
    + 'from your a/c ending 0000 at 9:00AM SGT, 24 Mar 26.', REF, '');
  assert.equal(row.amount, '-12345.67');
});

test('an unrecognised message carrying money returns null so the run fails loudly', () => {
  assert.equal(parseUob('Something never seen before, with SGD 5.00 in it', REF, 'Surprise'), null);
});
