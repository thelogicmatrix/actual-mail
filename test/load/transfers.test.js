import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairRows, namedAccount, WINDOW_MS } from '../../src/load/transfers.js';

// Two Actual accounts. The live mapping points several keys at one account, which is what
// rule 4 exists for, so this fixture reproduces that: `card` and `main` share ACCT_A.
const MAPPING = { main: 'ACCT_A', card: 'ACCT_A', uob: 'ACCT_B', wise: 'ACCT_C' };

const row = (over) => ({
  id: 'r' + Math.random().toString(36).slice(2), source: 'trust', account: 'main',
  date: '2026-08-27T13:11:00+08:00', amount: '-700.00', currency: 'SGD',
  payee: 'somebody', type: 'transfer_out', raw_ref: '<x>', ...over,
});

test('the window is two minutes, and it is a measured constant not a guess', () => {
  assert.equal(WINDOW_MS, 120000);
});

test('a debit and a matching credit in two accounts pair, outflow leg identified', () => {
  const out = row({ id: 'a', account: 'uob', amount: '-700.00' });
  const into = row({ id: 'b', account: 'main', amount: '700.00' });
  const { pairs, ambiguous } = pairRows([into, out], MAPPING);
  assert.equal(ambiguous, 0);
  assert.equal(pairs.length, 1);
  // The negative leg is always the one written, regardless of input order.
  assert.equal(pairs[0].out.id, 'a');
  assert.equal(pairs[0].into.id, 'b');
});

test('legs 18 seconds apart pair — the measured bank-to-Wise delta', () => {
  const out = row({ id: 'a', account: 'main', amount: '-2.53', date: '2026-08-27T21:50:00+08:00' });
  const into = row({ id: 'b', account: 'wise', amount: '2.53', date: '2026-08-27T13:50:18.172Z' });
  assert.equal(pairRows([out, into], MAPPING).pairs.length, 1);
});

test('legs exactly two minutes apart still pair', () => {
  const out = row({ id: 'a', account: 'uob', amount: '-700.00', date: '2026-08-27T13:11:00+08:00' });
  const into = row({ id: 'b', account: 'main', amount: '700.00', date: '2026-08-27T13:13:00+08:00' });
  assert.equal(pairRows([out, into], MAPPING).pairs.length, 1);
});

test('legs two minutes and one second apart do not pair', () => {
  const out = row({ id: 'a', account: 'uob', amount: '-700.00', date: '2026-08-27T13:11:00+08:00' });
  const into = row({ id: 'b', account: 'main', amount: '700.00', date: '2026-08-27T13:13:01+08:00' });
  assert.equal(pairRows([out, into], MAPPING).pairs.length, 0);
});

test('differing currencies never pair, even at an identical timestamp', () => {
  // This is the live Wise conversion: one movement inside one account, two currencies,
  // stamped to the same millisecond.
  const a = row({ id: 'a', account: 'wise', amount: '311.04', currency: 'SGD', date: '2026-08-23T18:27:26.579Z' });
  const b = row({ id: 'b', account: 'main', amount: '-311.04', currency: 'AUD', date: '2026-08-23T18:27:26.579Z' });
  assert.equal(pairRows([a, b], MAPPING).pairs.length, 0);
});

test('two keys resolving to ONE Actual account never pair', () => {
  // A Trust card spend and a Trust credit two minutes apart. `card` and `main` are different
  // mapping keys and the same account, so a key comparison would book a Trust-to-Trust
  // transfer and hide both a real spend and a real credit.
  const a = row({ id: 'a', account: 'card', amount: '-50.00' });
  const b = row({ id: 'b', account: 'main', amount: '50.00' });
  assert.equal(pairRows([a, b], MAPPING).pairs.length, 0);
});

test('an unmapped account never pairs', () => {
  const a = row({ id: 'a', account: 'nope', amount: '-50.00' });
  const b = row({ id: 'b', account: 'main', amount: '50.00' });
  assert.equal(pairRows([a, b], MAPPING).pairs.length, 0);
});

test('zero-amount rows never pair, because 0 === -0', () => {
  const a = row({ id: 'a', account: 'uob', amount: '0.00' });
  const b = row({ id: 'b', account: 'main', amount: '0.00' });
  assert.equal(pairRows([a, b], MAPPING).pairs.length, 0);
});

test('an ambiguous set is refused and counted, not guessed', () => {
  const a = row({ id: 'a', account: 'uob', amount: '-50.00' });
  const b = row({ id: 'b', account: 'main', amount: '50.00' });
  const c = row({ id: 'c', account: 'main', amount: '50.00' });
  const { pairs, ambiguous } = pairRows([a, b, c], MAPPING);
  assert.equal(pairs.length, 0);
  assert.ok(ambiguous > 0);
});

test('a differing amount scale still pairs, because comparison is in minor units', () => {
  const a = row({ id: 'a', account: 'uob', amount: '-50.00' });
  const b = row({ id: 'b', account: 'main', amount: '50.0' });
  assert.equal(pairRows([a, b], MAPPING).pairs.length, 1);
});

test('pot transfers are excluded — they already have their own path', () => {
  const a = row({ id: 'a', account: 'main', amount: '-50.00', type: 'pot_transfer', payee: 'TEST POT' });
  const b = row({ id: 'b', account: 'uob', amount: '50.00' });
  assert.equal(pairRows([a, b], MAPPING).pairs.length, 0);
});

test('a payee naming a mapped account resolves to that key', () => {
  // Trust writes this on a local transfer, so ONE email describes both sides.
  assert.equal(namedAccount(row({ payee: 'A/C ending 0000' }), { '0000': 'ACCT_B' }), '0000');
});

test('a payee naming an UNmapped account resolves to null', () => {
  // An unmapped four-digit group is somebody ELSE'S account and must stay an ordinary payee.
  // Expressed by omitting the key from the mapping rather than by using different digits:
  // scripts/scan-pii.js waves through only all-zero digit runs, so ANY other four-digit
  // ending in a committed file fails the PII gate — including one written inside a comment,
  // since comments are scanned too. Global constraint, not a stylistic choice.
  assert.equal(namedAccount(row({ payee: 'A/C ending 0000' }), { main: 'ACCT_A' }), null);
});

test('a payee naming no account at all resolves to null', () => {
  // The Wise seam: neither leg names a counterparty, which is why pairing exists.
  assert.equal(namedAccount(row({ payee: 'Topped up account' }), { '0000': 'ACCT_B' }), null);
  assert.equal(namedAccount(row({ payee: 'WISE ASIA-PACIFIC PTE LTD' }), { '0000': 'ACCT_B' }), null);
});
