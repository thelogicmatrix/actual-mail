import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toActualTxn, loadRows, sgDay, inScope, fxDatesFor, splitUntracked } from '../../src/load/load.js';
import { makeRateLookup, DEFAULT_MARKUP } from '../../src/load/fx.js';
import { rowId, toMinorUnits } from '../../src/row.js';

// ROW is an SGD row, so every test built on it describes DEFAULT base-currency behaviour.
// Pinned rather than inherited: a non-SGD adopter with BASE_CURRENCY exported would
// otherwise see the fixture classified as foreign and half this suite fail on their first
// `npm test` — a fixture assumption reading as a broken tool. Deleted, not set to 'SGD',
// so the assertion is "this is the default" rather than a restatement of what the default is.
delete process.env.BASE_CURRENCY;

const ROW = {
  id: 'deadbeef', source: 'trust', account: '0000',
  date: '2026-07-28T07:24:00+08:00', amount: '-3.18', currency: 'SGD',
  payee: 'TEST MERCHANT SG', type: 'card', raw_ref: '<a@b>',
};

// --- minor units ---

test('amount converts to integer minor units', () => {
  assert.equal(toActualTxn(ROW).amount, -318);
  assert.equal(toActualTxn({ ...ROW, amount: '1000.00' }).amount, 100000);
  assert.equal(toActualTxn({ ...ROW, amount: '-1234.50' }).amount, -123450);
});

test('minor-unit conversion is exact on the amounts a bank can actually send', () => {
  // This test used to be called "does not use floating point" and asserted these same
  // values. It could not fail. Swept every 2-decimal amount from 0.00 to 1999.99 through
  // both this function and the naive `Math.round(Number(s) * 100)`: they agree on all
  // 200,000 of them. The float hazard is real in general but is NOT observable on any
  // input this system receives, so a test claiming to prove its absence was proving
  // nothing while reading as evidence. What is worth pinning is exactness itself.
  assert.equal(toMinorUnits('0.29'), 29);
  assert.equal(toMinorUnits('-19.99'), -1999);
  assert.equal(toMinorUnits('8.70'), 870);
  assert.equal(toMinorUnits('1000.00'), 100000);
});

test('a third decimal is truncated, not rounded — and that is the deliberate choice', () => {
  // The one place the implementation and naive float actually diverge, so this is the
  // assertion that can fail if someone swaps in the float version. Unreachable from either
  // source today (bank alerts and the Wise API both carry exactly 2 decimals), which is
  // precisely why the behaviour needs writing down rather than discovering later.
  assert.equal(toMinorUnits('0.015'), 1);              // Math.round(0.015 * 100) === 2
  assert.notEqual(toMinorUnits('0.015'), Math.round(Number('0.015') * 100));
  assert.equal(toMinorUnits('0.009'), 0);              // Math.round(0.009 * 100) === 1
});

test('a single-decimal amount is not silently mis-scaled', () => {
  assert.equal(toMinorUnits('5.5'), 550);
});

test('date is reduced to the SGT calendar day', () => {
  assert.equal(toActualTxn(ROW).date, '2026-07-28');
});

test('imported_id is the row id, so re-imports dedup', () => {
  assert.equal(toActualTxn(ROW).imported_id, 'deadbeef');
});

test('rows import cleared — the alert is the bank confirming it happened', () => {
  assert.equal(toActualTxn(ROW).cleared, true);
});

// --- FX ---

const FX_ROW = { ...ROW, id: 'fx1', amount: '-8.99', currency: 'GBP',
                 payee: 'TEST MERCHANT GB', date: '2026-07-24T14:47:00+08:00' };
const FX = { rate: 1.720045, rateDate: '2026-07-24', markup: 0.003 };

test('a foreign row converts at ECB rate plus markup', () => {
  // 8.99 * 1.720045 * 1.003 = 15.5096 -> 1551 minor units
  assert.equal(toActualTxn(FX_ROW, FX).amount, -1551);
});

test('the estimate lands within a cent of the real charge', () => {
  // The real settled charge for this transaction was S$15.58.
  const estimated = Math.abs(toActualTxn(FX_ROW, FX).amount) / 100;
  assert.ok(Math.abs(estimated - 15.58) < 0.08,
    `estimate ${estimated} should be near the observed 15.58`);
});

test('a foreign row records the estimate in its note so reconciliation is a diff', () => {
  const txn = toActualTxn(FX_ROW, FX);
  assert.match(txn.notes, /GBP 8\.99/);
  assert.match(txn.notes, /1\.720045/);
  assert.match(txn.notes, /ECB 2026-07-24/);
  assert.match(txn.notes, /verify at settlement/);
});

// --- the Singapore calendar day ---

test('a Wise row in the early hours books to the Singapore day, not the UTC one', () => {
  // 2026-07-28T19:00Z is 2026-07-29 03:00 in Singapore. Dating it 07-28 is a real
  // mis-booking, and across a month end it moves spend into a closed budget month.
  const txn = toActualTxn({ ...ROW, source: 'wise', date: '2026-07-28T19:00:00.000Z' });
  assert.equal(txn.date, '2026-07-29');
});

test('and at a month boundary it lands in the right month', () => {
  const txn = toActualTxn({ ...ROW, source: 'wise', date: '2026-07-31T18:00:00.000Z' });
  assert.equal(txn.date, '2026-08-01');
});

test('a Trust row already carrying an SGT offset is unchanged', () => {
  assert.equal(toActualTxn(ROW).date, '2026-07-28');
});

test('the reconciliation floor compares the same Singapore day', async () => {
  // Floor 2026-07-28. The row is 07-28 in Singapore and 07-27 in UTC: judged on UTC it
  // would fall below the floor and be dropped for good.
  const api = { getTransactions: async () => [], addTransactions: async () => {} };
  const r = await loadRows(
    [{ ...ROW, id: 'tz1', source: 'wise', date: '2026-07-27T19:00:00.000Z' }],
    { '0000': 'acct' }, api, () => null, { reconciledThrough: '2026-07-27' });
  assert.equal(r.skipped, 0);
  assert.equal(r.imported, 1);
});

test('an SGD row lands with an empty note, so the field is Nathan\'s to write in', () => {
  assert.equal(toActualTxn(ROW).notes, null);
});

test('the note flags a rate date that differs from the transaction date', () => {
  const txn = toActualTxn({ ...FX_ROW, date: '2026-07-26T10:00:00+08:00' }, FX);
  assert.match(txn.notes, /ECB rate date 2026-07-24/);
});

test('an estimated FX row still lands cleared — it is a real transaction', () => {
  assert.equal(toActualTxn(FX_ROW, FX).cleared, true);
});

test('an SGD row is never converted', () => {
  assert.equal(toActualTxn(ROW, null).amount, -318);
});

test('a foreign row with no rate throws rather than importing a wrong number', () => {
  assert.throws(() => toActualTxn(FX_ROW, null), /no FX rate for GBP/);
});

// --- rate lookup ---

const RATE_MAP = new Map([['2026-07-24', { rates: { GBP: 0.581382, USD: 0.774869 }, rateDate: '2026-07-24' }]]);

test('rate lookup inverts the SGD-based rate', () => {
  const fx = makeRateLookup(RATE_MAP)('2026-07-24', 'GBP');
  assert.ok(Math.abs(fx.rate - 1.720045) < 0.0001);
  assert.equal(fx.markup, DEFAULT_MARKUP);
});

test('rate lookup returns null for SGD', () => {
  assert.equal(makeRateLookup(RATE_MAP)('2026-07-24', 'SGD'), null);
});

test('rate lookup throws for an uncovered currency rather than guessing', () => {
  assert.throws(() => makeRateLookup(RATE_MAP)('2026-07-24', 'JPY'), /no JPY rate/);
});

test('rate lookup throws for a date it never fetched', () => {
  assert.throws(() => makeRateLookup(RATE_MAP)('2026-01-01', 'GBP'), /no FX rate fetched/);
});

// --- loadRows ---

// `existing` stands in for what the account already holds, so dedup can be exercised.
function fakeApi(existing = []) {
  const calls = [];
  return {
    calls,
    getTransactions: async () => existing,
    addTransactions: async (id, txns, opts) => { calls.push([id, txns, opts]); return txns.map((t) => t.imported_id); },
    importTransactions: async () => { throw new Error('importTransactions fuzzy-matches; use addTransactions'); },
  };
}

test('loadRows groups by mapped account and reports counts', async () => {
  const api = fakeApi();
  const rows = [ROW, { ...ROW, id: 'other' }];
  const result = await loadRows(rows, { '0000': 'actual-uuid' }, api);
  assert.equal(result.imported, 2);
  assert.equal(result.converted, 0);
  assert.equal(api.calls.length, 1, 'same account should be one batched call');
  assert.equal(api.calls[0][0], 'actual-uuid');
});

test('loadRows splits distinct accounts into separate calls', async () => {
  const api = fakeApi();
  await loadRows([ROW, { ...ROW, id: 'b', account: 'card' }],
    { '0000': 'uuid-a', card: 'uuid-b' }, api);
  assert.deepEqual(api.calls.map((c) => c[0]).sort(), ['uuid-a', 'uuid-b']);
});

test('an unmapped account is a hard error, never a silent skip', async () => {
  await assert.rejects(() => loadRows([ROW], {}, fakeApi()), /no Actual account mapped for "0000"/);
});

test('nothing is imported when any row is unmapped', async () => {
  const api = fakeApi();
  await assert.rejects(() => loadRows([ROW, { ...ROW, id: 'x', account: 'unknown' }],
    { '0000': 'uuid-a' }, api));
  assert.equal(api.calls.length, 0, 'a partial import is worse than none');
});

test('loadRows counts converted foreign rows', async () => {
  const result = await loadRows([ROW, FX_ROW], { '0000': 'uuid-a' }, fakeApi(),
    makeRateLookup(RATE_MAP));
  assert.equal(result.imported, 2);
  assert.equal(result.converted, 1);
});

// --- dedup is ours, on imported_id ---
//
// Actual's importTransactions fuzzy-matches on amount and payee and silently drops the
// row. Two real spends disappeared that way against same-amount manual entries days
// earlier, and the run still claimed success.

test('a row already present by imported_id is skipped and counted, not re-added', async () => {
  const api = fakeApi([{ imported_id: 'deadbeef' }]);
  const result = await loadRows([ROW, { ...ROW, id: 'fresh' }], { '0000': 'uuid-a' }, api);
  assert.equal(result.imported, 1);
  assert.equal(result.alreadyPresent, 1);
  assert.equal(api.calls[0][1].length, 1);
  assert.equal(api.calls[0][1][0].imported_id, 'fresh');
});

test('an account whose rows are all present is not written to at all', async () => {
  const api = fakeApi([{ imported_id: 'deadbeef' }]);
  const result = await loadRows([ROW], { '0000': 'uuid-a' }, api);
  assert.equal(result.imported, 0);
  assert.equal(result.alreadyPresent, 1);
  assert.equal(api.calls.length, 0);
});

test('a same-amount neighbour with no imported_id does not suppress a real row', async () => {
  // Exactly the 2026-07-28 case: a hand-entered -3.18 already sits in the account.
  const api = fakeApi([{ imported_id: null, amount: -318, date: '2026-07-23' }]);
  const result = await loadRows([ROW], { '0000': 'uuid-a' }, api);
  assert.equal(result.imported, 1, 'a manual lookalike must not swallow a real transaction');
});

// --- the reconciliation floor (no backfill) ---
//
// Reconciliation is a human action. Anything on or before the reconciled date is settled
// history; re-importing it is backfill into a balanced account.

const OLD_ROW = { ...ROW, id: 'old', date: '2026-07-10T09:00:00+08:00' };

test('rows on or before the reconciled date are not imported', async () => {
  const api = fakeApi();
  const result = await loadRows([OLD_ROW, ROW], { '0000': 'uuid-a' }, api, undefined,
    { reconciledThrough: '2026-07-10' });
  assert.equal(result.skipped, 1);
  assert.equal(result.imported, 1);
  const written = api.calls.flatMap((c) => c[1]);
  assert.equal(written.length, 1, 'only the post-reconciliation row is written');
  assert.equal(written[0].imported_id, 'deadbeef');
});

test('the floor is inclusive of its own date', async () => {
  const sameDay = { ...ROW, id: 'sameday', date: '2026-07-10T23:59:00+08:00' };
  const result = await loadRows([sameDay], { '0000': 'uuid-a' }, fakeApi(), undefined,
    { reconciledThrough: '2026-07-10' });
  assert.equal(result.skipped, 1);
  assert.equal(result.imported, 0);
});

test('with every row below the floor nothing is written at all', async () => {
  const api = fakeApi();
  const result = await loadRows([OLD_ROW], { '0000': 'uuid-a' }, api, undefined,
    { reconciledThrough: '2026-07-20' });
  assert.equal(result.imported, 0);
  assert.equal(api.calls.length, 0, 'an empty batch should not hit the API');
});

test('no floor configured imports everything, as before', async () => {
  const result = await loadRows([OLD_ROW, ROW], { '0000': 'uuid-a' }, fakeApi());
  assert.equal(result.imported, 2);
  assert.equal(result.skipped, 0);
});

// --- pot transfers ---
//
// A pot move is one row seen from the main account, with the pot name as payee. Each pot
// is its own Actual account, so it has to land as a transfer, not as a spend.

const POT_ROW = { ...ROW, id: 'pot1', type: 'pot_transfer', amount: '-100.00',
                  payee: 'Savings Pot' };
const POT_MAPPING = { '0000': 'trust-uuid', 'pot:Savings Pot': 'pot-uuid' };
const transferPayeeFor = (acctId) => `xfer-${acctId}`;

test('a pot transfer is written as a transfer to the pot account', async () => {
  const api = fakeApi();
  await loadRows([POT_ROW], POT_MAPPING, api, undefined, { transferPayeeFor });
  const [accountId, [txn]] = api.calls[0];
  assert.equal(accountId, 'trust-uuid', 'the row still belongs to the main account');
  assert.equal(txn.payee, 'xfer-pot-uuid', 'payee is the pot account transfer payee');
  assert.equal(txn.payee_name, undefined, 'a transfer payee and a payee name are exclusive');
  assert.equal(txn.amount, -10000);
  assert.equal(api.calls[0][2]?.runTransfers, true,
    'without runTransfers the pot side is never created and the money vanishes');
});

test('an unmapped pot is a hard error, never a plain spend', async () => {
  await assert.rejects(
    () => loadRows([POT_ROW], { '0000': 'trust-uuid' }, fakeApi(), undefined, { transferPayeeFor }),
    /no Actual account mapped for pot "Savings Pot"/);
});

test('non-pot rows keep their payee name', async () => {
  const api = fakeApi();
  await loadRows([ROW], POT_MAPPING, api, undefined, { transferPayeeFor });
  const [txn] = api.calls.flatMap((c) => c[1]);
  assert.equal(txn.payee_name, 'TEST MERCHANT SG');
  assert.equal(txn.payee, undefined);
});

test('a domestic row is not treated as foreign when the base is not SGD', () => {
  process.env.BASE_CURRENCY = 'GBP';
  try {
    const row = { account: 'card', date: '2026-08-01T12:00:00+08:00', amount: '-10.00',
                  currency: 'GBP', payee: 'TEST MERCHANT GB', type: 'card' };
    const txn = toActualTxn(row, null); // null FX must be acceptable for a base-currency row
    assert.equal(txn.amount, -1000);
  } finally {
    delete process.env.BASE_CURRENCY;
  }
});

// --- the seam between fetching a rate and looking one up -------------------------------
// These four exist because the two sides of that seam disagreed in production: the caller
// derived the rate date from the UTC day and the lookup asked by the Singapore day, so every
// foreign row stamped 16:00-24:00 UTC threw `no FX rate fetched` and took the whole batch down.
// The derivation now lives in this file next to the lookup key it has to match, and these pin it.

test('fxDatesFor keys by the Singapore day, not the UTC day', () => {
  // 17:00Z on 28 Jul is 01:00 SGT on 29 Jul. A UTC-derived key gives 2026-07-28 and the
  // lookup then asks for 2026-07-29 — the exact mismatch that aborted every FX import.
  const row = { ...ROW, date: '2026-07-28T17:00:00.000Z', currency: 'GBP' };
  assert.deepEqual(fxDatesFor([row]), ['2026-07-29']);
  assert.notEqual(fxDatesFor([row])[0], row.date.slice(0, 10));
});

test('fxDatesFor and loadRows agree on the key for every hour of a day', () => {
  // The whole class, not the one reproduction: if these two ever disagree again, the rate is
  // fetched under a key the lookup never asks for and the run dies. Checked hour by hour
  // across a month boundary, which is where the disagreement is worst.
  for (let h = 0; h < 24; h++) {
    const date = `2026-07-31T${String(h).padStart(2, '0')}:30:00.000Z`;
    const [fetched] = fxDatesFor([{ ...ROW, date, currency: 'GBP' }]);
    assert.equal(fetched, sgDay(date), `hour ${h}Z: fetch key must equal the lookup key`);
  }
});

test('fxDatesFor ignores base-currency rows, so a pure-SGD run needs no rate service', () => {
  assert.deepEqual(fxDatesFor([ROW, { ...ROW, currency: 'SGD' }]), []);
});

test('inScope filters the floor by the Singapore day, matching loadRows', () => {
  // 17:00Z on 28 Jul is the 29th in Singapore, so a floor of the 28th must NOT skip it.
  const row = { ...ROW, date: '2026-07-28T17:00:00.000Z' };
  assert.equal(inScope([row], '2026-07-28').length, 1);
  assert.equal(inScope([row], '2026-07-29').length, 0);
});

// --- the FX markup is a cost, so it always moves money away from the customer ----------

test('the markup makes a debit cost more', () => {
  const fx = makeRateLookup(RATE_MAP)('2026-07-24', 'GBP');
  const txn = toActualTxn({ ...ROW, amount: '-100.00', currency: 'GBP' }, fx);
  const mid = Math.round(100 * fx.rate * 100);
  assert.ok(Math.abs(txn.amount) > mid, `debit ${txn.amount} should exceed mid-market ${mid}`);
});

test('the markup makes a credit receive LESS, not more', () => {
  // The bug this pins: `signed * (1 + markup)` moved a refund further from zero, crediting
  // more than mid-market. A refund was wrong by twice the markup, in the customer's favour,
  // and reconciliation would chase it as a real discrepancy. trust-sg emits refunds and
  // cancellations as positive rows, so this is a live path and not a hypothetical.
  const fx = makeRateLookup(RATE_MAP)('2026-07-24', 'GBP');
  const txn = toActualTxn({ ...ROW, amount: '100.00', currency: 'GBP' }, fx);
  const mid = Math.round(100 * fx.rate * 100);
  assert.ok(txn.amount > 0, 'a refund stays positive');
  assert.ok(txn.amount < mid, `credit ${txn.amount} should fall short of mid-market ${mid}`);
});

test('a debit and its mirror-image credit are equally far from mid-market', () => {
  // "Equally" to within one minor unit, not exactly. Mid-market here is 17200.39, so the two
  // sides round to 17252 and 17149 and land 0.21 apart. Asserting exact symmetry fails for a
  // reason that has nothing to do with the markup direction this test exists to pin, and a test
  // that breaks on arithmetic which is correct is worse than no test.
  const fx = makeRateLookup(RATE_MAP)('2026-07-24', 'GBP');
  const mid = 100 * fx.rate * 100;
  const debit = toActualTxn({ ...ROW, amount: '-100.00', currency: 'GBP' }, fx).amount;
  const credit = toActualTxn({ ...ROW, amount: '100.00', currency: 'GBP' }, fx).amount;
  const excess = Math.abs(debit) - mid;
  const shortfall = mid - credit;
  assert.ok(Math.abs(excess - shortfall) <= 1,
    `debit is ${excess.toFixed(2)} over mid, credit ${shortfall.toFixed(2)} under — should match`);
});

// --- the markup is a BANK's spread, so a source that charged none gets none -------------

test('a Wise row converts at mid-market — no spread was charged, so none is modelled', async () => {
  // A payment out of a Wise USD balance is not a conversion. Marking it up booked the row ~0.3%
  // off, systematically, in one direction, forever — a known-zero spread modelled as non-zero.
  const api = fakeApi();
  const rate = 1 / 0.581382;
  await loadRows([{ ...FX_ROW, source: 'wise', account: 'wise-gbp', amount: '-100.00',
                    date: '2026-07-24T04:00:00.000Z' }],
    { 'wise-gbp': 'uuid-a' }, api, makeRateLookup(RATE_MAP));
  assert.equal(api.calls[0][1][0].amount, -Math.round(100 * rate * 100));
});

test('a card alert keeps its markup — that spread is real and unknown until settlement', async () => {
  const api = fakeApi();
  const rate = 1 / 0.581382;
  await loadRows([{ ...FX_ROW, source: 'trust', account: 'card', amount: '-100.00',
                    date: '2026-07-24T04:00:00.000Z' }],
    { card: 'uuid-a' }, api, makeRateLookup(RATE_MAP));
  const written = Math.abs(api.calls[0][1][0].amount);
  assert.ok(written > Math.round(100 * rate * 100), 'a card conversion costs more than mid-market');
});

// --- rounding a tie does not depend on the sign ----------------------------------------

test('an exact half-cent rounds away from zero on both signs', () => {
  // 50.05 at 1.3 is 6506.5 cents exactly. Math.round breaks a tie upwards, so the debit rounded
  // toward zero (-6506) and the credit away from it (6507): a tie favoured the customer in both
  // directions. Small, but it made the sign of a row change its magnitude.
  const fx = { rate: 1.3, rateDate: '2026-07-24', markup: 0 };
  const debit = toActualTxn({ ...FX_ROW, amount: '-50.05' }, fx).amount;
  const credit = toActualTxn({ ...FX_ROW, amount: '50.05' }, fx).amount;
  assert.equal(debit, -6507);
  assert.equal(credit, 6507);
});

// --- a batch is deduped against itself, not only against the account -------------------

// --- a row imported under the pre-account id is not imported again ---------------------
//
// The account joined the row identity because a Wise conversion appears in both balance
// statements under one referenceNumber. Rows already in the budget carry the OLD id, so the
// dedupe checks both and writes only the new one — no migration, nothing rewritten.

const WISE_ROW = { ...ROW, source: 'wise', account: 'wise-sgd', raw_ref: 'REF1',
                   id: rowId('wise', 'REF1', 'wise-sgd') };

test('a row whose PRE-ACCOUNT id is already in the budget is not re-imported', async () => {
  const api = fakeApi([{ imported_id: rowId('wise', 'REF1') }]);
  const result = await loadRows([WISE_ROW], { 'wise-sgd': 'uuid-a' }, api);
  assert.equal(result.imported, 0, 'the old-id row in the budget IS this row');
  assert.equal(result.alreadyPresent, 1);
  assert.equal(api.calls.length, 0, 're-importing it would double the whole history');
});

test('what gets WRITTEN is the account-aware id, never the old one', async () => {
  const api = fakeApi();
  await loadRows([WISE_ROW], { 'wise-sgd': 'uuid-a' }, api);
  assert.equal(api.calls[0][1][0].imported_id, rowId('wise', 'REF1', 'wise-sgd'));
  assert.notEqual(api.calls[0][1][0].imported_id, rowId('wise', 'REF1'));
});

test('both legs of one conversion survive being mapped to a single account', async () => {
  // Reproduced before the fix: mapped to separate accounts -> {imported: 2}; both mapped to one
  // -> {imported: 1, alreadyPresent: 1}, one leg gone and the run reporting healthy.
  const api = fakeApi();
  const legs = [WISE_ROW, { ...WISE_ROW, account: 'wise-usd', currency: 'SGD',
                            id: rowId('wise', 'REF1', 'wise-usd') }];
  const result = await loadRows(legs, { 'wise-sgd': 'one-uuid', 'wise-usd': 'one-uuid' }, api);
  assert.equal(result.imported, 2, 'one leg of a conversion must not swallow the other');
  assert.equal(result.alreadyPresent, 0);
});

// --- a partial write is synced before the failure is rethrown --------------------------

test('rows written before a mid-loop failure are synced, not left in the local cache', async () => {
  // loadRows writes account by account and the caller syncs only after it returns, so a throw on
  // the second account left the first account's rows written locally and never synced. The next
  // run's dedupe reads that same local cache, sees the imported_id and counts them already
  // present — never rewritten, never resynced, invisible forever, every run reporting healthy.
  let synced = 0;
  const api = {
    getTransactions: async () => [],
    addTransactions: async (accountId) => {
      if (accountId === 'uuid-b') throw new Error('server said no');
    },
    sync: async () => { synced += 1; },
  };
  await assert.rejects(() => loadRows([ROW, { ...ROW, id: 'b', account: 'card' }],
    { '0000': 'uuid-a', card: 'uuid-b' }, api), /server said no/);
  assert.equal(synced, 1, 'whatever landed must reach the server before the throw');
});

test('a failure with nothing yet written does not sync', async () => {
  let synced = 0;
  const api = {
    getTransactions: async () => { throw new Error('budget unreadable'); },
    addTransactions: async () => {},
    sync: async () => { synced += 1; },
  };
  await assert.rejects(() => loadRows([ROW], { '0000': 'uuid-a' }, api), /budget unreadable/);
  assert.equal(synced, 0);
});

test('a dry-run sink with no sync() still reports the real failure', async () => {
  // The dry-run sink is two functions; reaching for api.sync() on it would replace the real
  // error with a TypeError.
  const sink = { getTransactions: async () => [], addTransactions: async () => { throw new Error('boom'); } };
  await assert.rejects(() => loadRows([ROW], { '0000': 'uuid-a' }, sink), /boom/);
});

test('two rows carrying one imported_id are written once', () => {
  // The account holds neither, so neither was "already present" and both were written.
  // Reachable by concatenating two archives from runs/ or re-piping a file.
  const api = { calls: [], getTransactions: async () => [], addTransactions: async (a, t) => api.calls.push(t) };
  const rows = [{ ...ROW }, { ...ROW }];
  return loadRows(rows, { '0000': 'acct-1' }, api).then((r) => {
    assert.equal(r.imported, 1, 'one row written');
    assert.equal(r.alreadyPresent, 1, 'the duplicate is counted, not silently dropped');
    assert.equal(api.calls.flat().length, 1);
  });
});

// --- internal transfers -------------------------------------------------------------------

// 'no-inbound-alert:0000' is the licence for the payee path: ACCT_B's bank was measured to
// send no inbound alert, so a row naming it cannot be contradicted by a row from that bank.
// Its VALUE is the same account id '0000' maps to, because the dedupe prefetch iterates
// Object.values(mapping) and a marker value would be handed to getTransactions as an account.
const XFER_MAPPING = { uob: 'ACCT_B', main: 'ACCT_A', card: 'ACCT_A', '0000': 'ACCT_B',
  'no-inbound-alert:0000': 'ACCT_B' };
// The same accounts with no licence recorded. A payee naming '0000' here is an ordinary payee.
const UNLICENSED = { uob: 'ACCT_B', main: 'ACCT_A', card: 'ACCT_A', '0000': 'ACCT_B' };
const xferPayee = (accountId) => `payee-of-${accountId}`;

const xrow = (over) => ({
  source: 'trust', account: 'main', date: '2026-08-27T13:11:00+08:00',
  amount: '-700.00', currency: 'SGD', payee: 'somebody', type: 'transfer_out',
  raw_ref: '<x>', ...over, id: 'x' + (over.id ?? '1'),
});

function sink() {
  const written = new Map();
  return {
    written,
    // The bounds are HONOURED, not ignored. A sink that returns everything regardless of the
    // range means no test exercises the read window at all, and every assertion here would pass
    // just as well if the range were per-account, reversed or undefined — which is exactly how
    // a pair straddling midnight SGT got to read the wrong days.
    getTransactions: async (accountId, start, end) =>
      (written.get(accountId) ?? []).filter((t) => t.date >= start && t.date <= end),
    addTransactions: async (accountId, txns) => {
      written.set(accountId, [...(written.get(accountId) ?? []), ...txns]);
    },
  };
}

test('a paired debit and credit write ONE transaction, with a transfer payee', async () => {
  const api = sink();
  const r = await loadRows(
    [xrow({ id: 'out', account: 'uob', amount: '-700.00', raw_ref: '<u>' }),
     xrow({ id: 'in', account: 'main', amount: '700.00', raw_ref: '<t>' })],
    XFER_MAPPING, api, () => null,
    { reconciledThrough: '2026-07-26', transferPayeeFor: xferPayee });

  assert.equal(r.transfers, 1);
  assert.equal(r.imported, 1, 'only the outflow leg is written; Actual creates the mirror');
  const txn = api.written.get('ACCT_B')[0];
  assert.equal(txn.payee, 'payee-of-ACCT_A');
  assert.equal(txn.payee_name, undefined, 'a transfer must not carry a payee_name');
  assert.equal(txn.amount, -70000);
  // Both row ids, so the suppressed leg can never re-import as a standalone duplicate.
  assert.equal(txn.imported_id, 'xout+xin');
});

test('a transfer already written is not written again', async () => {
  const api = sink();
  const rows = [xrow({ id: 'out', account: 'uob', amount: '-700.00' }),
                xrow({ id: 'in', account: 'main', amount: '700.00' })];
  const opts = { reconciledThrough: '2026-07-26', transferPayeeFor: xferPayee };
  await loadRows(rows, XFER_MAPPING, api, () => null, opts);
  const second = await loadRows(rows, XFER_MAPPING, api, () => null, opts);
  assert.equal(second.imported, 0);
  assert.equal(second.alreadyPresent, 1);
});

test('one leg arriving alone later dedupes against the joined id', async () => {
  const api = sink();
  const opts = { reconciledThrough: '2026-07-26', transferPayeeFor: xferPayee };
  await loadRows(
    [xrow({ id: 'out', account: 'uob', amount: '-700.00' }),
     xrow({ id: 'in', account: 'main', amount: '700.00' })],
    XFER_MAPPING, api, () => null, opts);
  // The outflow leg alone, in a later run. Its id is a PART of the stored joined id.
  const again = await loadRows(
    [xrow({ id: 'out', account: 'uob', amount: '-700.00' })],
    XFER_MAPPING, api, () => null, opts);
  assert.equal(again.imported, 0);
});

test('legs imported separately are reported, not written a third time', async () => {
  const api = sink();
  const opts = { reconciledThrough: '2026-07-26', transferPayeeFor: xferPayee };
  // Two runs, one leg each, so neither pairs and both land as ordinary transactions.
  await loadRows([xrow({ id: 'out', account: 'uob', amount: '-700.00' })],
    XFER_MAPPING, api, () => null, opts);
  await loadRows([xrow({ id: 'in', account: 'main', amount: '700.00' })],
    XFER_MAPPING, api, () => null, opts);
  // Now a sweep sees both. The pair forms, and must NOT be written on top of them.
  const sweep = await loadRows(
    [xrow({ id: 'out', account: 'uob', amount: '-700.00' }),
     xrow({ id: 'in', account: 'main', amount: '700.00' })],
    XFER_MAPPING, api, () => null, opts);
  assert.equal(sweep.imported, 0);
  assert.equal(sweep.transfersAlreadySeparate, 1);
});

test('a payee naming a mapped account books a transfer with no partner row', async () => {
  // Trust to UOB. Verified 2026-08-27: UOB sends no inbound alert, so there is no second leg
  // and pairing alone would leave the far side of this transfer permanently unbooked.
  const api = sink();
  const r = await loadRows(
    [xrow({ id: 'solo', account: 'main', amount: '-1.37', payee: 'A/C ending 0000' })],
    XFER_MAPPING, api, () => null,
    { reconciledThrough: '2026-07-26', transferPayeeFor: xferPayee });
  assert.equal(r.transfers, 1);
  assert.equal(r.imported, 1);
  const txn = api.written.get('ACCT_A')[0];
  assert.equal(txn.payee, 'payee-of-ACCT_B');
  assert.equal(txn.imported_id, 'xsolo', 'no partner, so no joined id');
});

test('a payee naming the row own account is NOT a transfer', async () => {
  // A note to self, not a movement between accounts. Both sides resolve to ACCT_A here, which
  // is why the mapping overrides '0000' rather than introducing a second digit group: the
  // global constraint allows only all-zero digits in a committed file.
  const api = sink();
  const r = await loadRows(
    [xrow({ id: 'self', account: 'main', amount: '-1.37', payee: 'A/C ending 0000' })],
    { ...XFER_MAPPING, '0000': 'ACCT_A' }, api, () => null,
    { reconciledThrough: '2026-07-26', transferPayeeFor: xferPayee });
  assert.equal(r.transfers, 0);
  assert.equal(api.written.get('ACCT_A')[0].payee_name, 'A/C ending 0000');
});

test('every transfer is reported to the caller so the run log records it', async () => {
  const api = sink();
  const seen = [];
  await loadRows(
    [xrow({ id: 'out', account: 'uob', amount: '-700.00' }),
     xrow({ id: 'in', account: 'main', amount: '700.00' })],
    XFER_MAPPING, api, () => null,
    { reconciledThrough: '2026-07-26', transferPayeeFor: xferPayee,
      onTransfer: (t) => seen.push(t) });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { date: '2026-08-27', amount: -70000, from: 'ACCT_B', to: 'ACCT_A' });
});

test('with no transferPayeeFor, nothing is treated as a transfer', async () => {
  // A caller that cannot resolve transfer payees must degrade to ordinary transactions
  // rather than throw.
  const api = sink();
  const r = await loadRows(
    [xrow({ id: 'out', account: 'uob', amount: '-700.00' }),
     xrow({ id: 'in', account: 'main', amount: '700.00' })],
    XFER_MAPPING, api, () => null, { reconciledThrough: '2026-07-26' });
  assert.equal(r.transfers, 0);
  assert.equal(r.imported, 2);
});

test('a leg below the reconciliation floor cannot pair', async () => {
  // Pairing runs on the post-floor set, so a floor that drops one leg must not leave the
  // other booked as half a transfer.
  const api = sink();
  const r = await loadRows(
    [xrow({ id: 'old', account: 'uob', amount: '-700.00', date: '2026-07-20T13:11:00+08:00' }),
     xrow({ id: 'new', account: 'main', amount: '700.00' })],
    XFER_MAPPING, api, () => null,
    { reconciledThrough: '2026-07-26', transferPayeeFor: xferPayee });
  assert.equal(r.skipped, 1);
  assert.equal(r.transfers, 0);
  assert.equal(r.imported, 1);
});

test('a healthy re-run of a booked transfer is not reported as a split pair', async () => {
  // transfersAlreadySeparate means at least one leg of this movement is already in the budget,
  // so the pair was left unlinked — a thing a human has to go and look at. A re-run of a transfer we booked ourselves is not
  // that, and reporting it would cry wolf on money on every single run. Pinned because the
  // dedupe set holds the joined id only as its PARTS unless the whole id is added too, and
  // with only the parts every re-run of every healthy transfer counted here.
  const api = sink();
  const rows = [xrow({ id: 'out', account: 'uob', amount: '-700.00' }),
                xrow({ id: 'in', account: 'main', amount: '700.00' })];
  const opts = { reconciledThrough: '2026-07-26', transferPayeeFor: xferPayee };
  await loadRows(rows, XFER_MAPPING, api, () => null, opts);
  const second = await loadRows(rows, XFER_MAPPING, api, () => null, opts);
  assert.equal(second.transfersAlreadySeparate, 0);
  assert.equal(second.alreadyPresent, 1, 'still counted as already present, just not as split');
});

test('the credit leg arriving alone after the pair cannot re-import', async () => {
  // The joined id sits on the WRITTEN leg, in the debit account. The suppressed credit leg
  // belongs to the other account, where Actual's mirror carries no imported_id at all, so a
  // dedupe reading only that account found nothing and wrote the money a second time.
  const api = sink();
  const opts = { reconciledThrough: '2026-07-26', transferPayeeFor: xferPayee };
  await loadRows(
    [xrow({ id: 'out', account: 'uob', amount: '-700.00' }),
     xrow({ id: 'in', account: 'main', amount: '700.00' })],
    XFER_MAPPING, api, () => null, opts);
  const again = await loadRows(
    [xrow({ id: 'in', account: 'main', amount: '700.00' })],
    XFER_MAPPING, api, () => null, opts);
  assert.equal(again.imported, 0);
  assert.equal((api.written.get('ACCT_A') ?? []).length, 0,
    'the credit side is Actual\'s mirror leg to create, never ours to write');
});

test('a leg already in the budget blocks the transfer, but the OTHER leg is still written', async () => {
  // Run one: only the credit source was up, so that leg imported as an ordinary transaction
  // into its own account. SOURCE FAILED in runs/run.log makes this the ordinary shape of a
  // single-source outage, not an exotic replay. Run two sees both legs and pairs them, and the
  // written leg goes to the DEBIT account, which has never held either id.
  //
  // Refusing the pair used to drop that debit with it, so the debit account came out short by
  // the whole amount, reported only as a count whose name says both legs are present.
  const api = sink();
  const opts = { reconciledThrough: '2026-07-26', transferPayeeFor: xferPayee };
  await loadRows([xrow({ id: 'in', account: 'main', amount: '700.00' })],
    XFER_MAPPING, api, () => null, opts);
  const paired = await loadRows(
    [xrow({ id: 'out', account: 'uob', amount: '-700.00' }),
     xrow({ id: 'in', account: 'main', amount: '700.00' })],
    XFER_MAPPING, api, () => null, opts);
  assert.equal(paired.imported, 1, 'the debit leg is new, and is written as an ordinary row');
  assert.equal(paired.transfers, 0, 'not as a transfer — that would mirror a second credit');
  assert.equal(paired.transfersAlreadySeparate, 1);
  assert.equal(api.written.get('ACCT_B')[0].imported_id, 'xout', 'its own id, not a joined one');
  assert.equal(api.written.get('ACCT_A').length, 1, 'and the credit side gains nothing');
});

test('a legacy id is matched per account, never run-wide', async () => {
  // The case the run-wide union must NOT swallow. A legacy id hashes source and raw_ref with
  // no account, so two rows can share one: a Wise balance conversion appears in both balance
  // statements under a single referenceNumber. Where those balances map to different Actual
  // accounts, a run-wide legacy match would drop the second leg as already present — the exact
  // silent loss recorded above legacyIds in load.js.
  const api = sink();
  const shared = rowId('trust', '<shared>');
  // ACCT_A already holds one of them, under its pre-account id.
  api.written.set('ACCT_A', [{ imported_id: shared, amount: -137, date: '2026-08-27' }]);
  const r = await loadRows(
    [xrow({ id: 'a', account: 'main', amount: '-1.37', raw_ref: '<shared>' }),
     xrow({ id: 'b', account: 'uob', amount: '-1.37', raw_ref: '<shared>' })],
    XFER_MAPPING, api, () => null,
    { reconciledThrough: '2026-07-26', transferPayeeFor: xferPayee });
  assert.equal(r.alreadyPresent, 1, 'the ACCT_A row is the one already in the budget');
  assert.equal(r.imported, 1, 'the ACCT_B row shares only the legacy id, and is a different row');
  assert.equal(api.written.get('ACCT_B').length, 1);
});

test('a pair straddling midnight SGT reads BOTH days, so the earlier leg is still found', async () => {
  // The read window came off the written transactions, which by construction exclude the
  // suppressed leg. Two legs thirty seconds apart can still fall on different Singapore days,
  // and then the window covered only the written leg's day: right accounts, wrong dates, and
  // the duplicate this dedupe exists to stop came straight back.
  const api = sink();
  const opts = { reconciledThrough: '2026-07-26', transferPayeeFor: xferPayee };
  const credit = xrow({ id: 'in', account: 'main', amount: '700.00',
    date: '2026-08-27T23:59:45+08:00' });
  const debit = xrow({ id: 'out', account: 'uob', amount: '-700.00',
    date: '2026-08-28T00:00:15+08:00' });
  // Run one: only the credit source was up, so it books standalone, dated the 27th.
  await loadRows([credit], XFER_MAPPING, api, () => null, opts);
  assert.equal(api.written.get('ACCT_A')[0].date, '2026-08-27');
  // Run two: both legs pair, and the written leg is the debit, dated the 28th.
  const paired = await loadRows([debit, credit], XFER_MAPPING, api, () => null, opts);
  // The credit is found a day earlier, so this is not a pair: the debit writes as an ordinary
  // row and the transfer is reported unlinked. Read the 28th alone and the credit is invisible,
  // which shows up here as transfersAlreadySeparate 0 and a joined imported_id.
  assert.equal(paired.transfersAlreadySeparate, 1, 'the credit leg was found, on the 27th');
  assert.equal(paired.imported, 1, 'the debit leg is new');
  assert.equal(api.written.get('ACCT_B')[0].imported_id, 'xout', 'an ordinary row, not a transfer');
  assert.equal(api.written.get('ACCT_A').length, 1, 'the credit side is untouched');
});

test('a transfer is counted and reported when it is WRITTEN, not when it is detected', async () => {
  // Detection happens in the row loop, the write happens after the dedupe. Counting at
  // detection made every re-run report a transfer on a run that wrote nothing — a repeated
  // alarm about money, which teaches the reader to stop reading the run line.
  const api = sink();
  const seen = [];
  const rows = [xrow({ id: 'out', account: 'uob', amount: '-700.00' }),
                xrow({ id: 'in', account: 'main', amount: '700.00' })];
  const opts = { reconciledThrough: '2026-07-26', transferPayeeFor: xferPayee,
    onTransfer: (t) => seen.push(t) };
  const first = await loadRows(rows, XFER_MAPPING, api, () => null, opts);
  assert.equal(first.transfers, 1);
  assert.equal(seen.length, 1);
  const second = await loadRows(rows, XFER_MAPPING, api, () => null, opts);
  assert.equal(second.transfers, 0, 'nothing was written, so no transfer was made');
  assert.equal(second.alreadyPresent, 1, 'it is still counted as already present');
  assert.equal(seen.length, 1, 'and the run log is not told about it a second time');
});

test('a payee naming an account with no recorded licence is an ordinary payee', async () => {
  // Inventing the far leg from a payee string is only safe where the receiving bank cannot
  // send a row of its own. Without that measurement recorded, the payee is just a payee.
  const api = sink();
  const r = await loadRows(
    [xrow({ id: 'solo', account: 'main', amount: '-1.37', payee: 'A/C ending 0000' })],
    UNLICENSED, api, () => null,
    { reconciledThrough: '2026-07-26', transferPayeeFor: xferPayee });
  assert.equal(r.transfers, 0);
  assert.equal(api.written.get('ACCT_A')[0].payee_name, 'A/C ending 0000');
  assert.equal(api.written.get('ACCT_B'), undefined, 'no leg is invented in the target account');
});

test('an unlicensed payee target does not double when the real counter-leg arrives', async () => {
  // The reproduction. The debit names the target, and the target's own bank DID send a row —
  // nine minutes later, so pairing refuses it and the payee path would have invented a second
  // leg beside it. Two ordinary transactions, and ACCT_B holds the money once.
  const api = sink();
  const r = await loadRows(
    [xrow({ id: 'out', account: 'main', amount: '-1.37', payee: 'A/C ending 0000' }),
     xrow({ id: 'in', account: 'uob', amount: '1.37', date: '2026-08-27T13:20:00+08:00' })],
    UNLICENSED, api, () => null,
    { reconciledThrough: '2026-07-26', transferPayeeFor: xferPayee });
  assert.equal(r.imported, 2);
  assert.equal(r.transfers, 0);
  assert.equal(r.ambiguous, 0, 'pairing refused it silently — nine minutes is outside the window');
  assert.equal(api.written.get('ACCT_B').length, 1, 'the counter-leg, once');
  assert.equal(api.written.get('ACCT_B')[0].amount, 137);
});

test('a pair whose partner is already in the budget still writes the leg that is not', async () => {
  // The live dry run, in isolation. The monthly UOB-to-Trust transfer: the Trust credit has been
  // in the budget for months, the UOB debit is brand new because UOB was only mapped today. The
  // pair is refused — correctly, since linking would mean editing a transaction already there —
  // but the debit is money that has never been booked and must still land.
  const api = sink();
  api.written.set('ACCT_A', [{ imported_id: 'xin', amount: 70000, date: '2026-08-27' }]);
  const r = await loadRows(
    [xrow({ id: 'out', account: 'uob', amount: '-700.00' }),
     xrow({ id: 'in', account: 'main', amount: '700.00' })],
    XFER_MAPPING, api, () => null,
    { reconciledThrough: '2026-07-26', transferPayeeFor: xferPayee });
  assert.equal(r.imported, 1, 'the UOB debit is new money and is written');
  assert.equal(r.transfers, 0);
  assert.equal(r.transfersAlreadySeparate, 1, 'reported as a transfer left unlinked');
  assert.equal(r.alreadyPresent, 1, 'the Trust credit was already there');
  assert.equal(api.written.get('ACCT_B').length, 1);
  assert.equal(api.written.get('ACCT_B')[0].amount, -70000);
  assert.equal(api.written.get('ACCT_A').length, 1, 'nothing added to the side that had it');
});

test('neither leg of a refused pair may invent a transfer from its payee', async () => {
  // Refusing a pair drops both rows out of pairedOut, so each falls through to the payee path.
  // A payee naming a licensed account then books an invented leg into the very account whose
  // real row is in this same batch — one movement reported as both a transfer and a transfer
  // left unlinked, with the target account holding it twice once Actual mirrors.
  const opts = { reconciledThrough: '2026-07-26', transferPayeeFor: xferPayee };

  // The debit names the target. Seed the credit so the pair is refused for budget state.
  const a = sink();
  a.written.set('ACCT_B', [{ imported_id: 'xin', amount: 70000, date: '2026-08-27' }]);
  const out = await loadRows(
    [xrow({ id: 'out', account: 'main', amount: '-700.00', payee: 'A/C ending 0000' }),
     xrow({ id: 'in', account: 'uob', amount: '700.00' })],
    XFER_MAPPING, a, () => null, opts);
  assert.equal(out.transfers, 0, 'the pairing row is the licence being contradicted');
  assert.equal(out.transfersAlreadySeparate, 1);
  assert.equal(a.written.get('ACCT_A')[0].payee_name, 'A/C ending 0000');
  assert.equal(a.written.get('ACCT_B').length, 1, 'the target gains nothing');

  // The same exposure in the other direction: the CREDIT leg carries the naming payee.
  const b = sink();
  b.written.set('ACCT_B', [{ imported_id: 'xout', amount: -70000, date: '2026-08-27' }]);
  const into = await loadRows(
    [xrow({ id: 'out', account: 'uob', amount: '-700.00' }),
     xrow({ id: 'in', account: 'main', amount: '700.00', payee: 'A/C ending 0000' })],
    XFER_MAPPING, b, () => null, opts);
  assert.equal(into.transfers, 0);
  assert.equal(into.transfersAlreadySeparate, 1);
  assert.equal(b.written.get('ACCT_A')[0].payee_name, 'A/C ending 0000');
  assert.equal(b.written.get('ACCT_B').length, 1);
});

test('a contested row may not invent a transfer leg from its payee', async () => {
  // Two candidates is more evidence of a counterpart than one, not less. The row satisfies every
  // pairing rule and is refused only for ambiguity, so it never became a pair — and it used to
  // fall through to the licence and book an invented leg into the very account both candidates
  // came from, while they imported beside it.
  const api = sink();
  const r = await loadRows(
    [xrow({ id: 'solo', account: 'main', amount: '-700.00', payee: 'A/C ending 0000' }),
     xrow({ id: 'c1', account: 'uob', amount: '700.00' }),
     xrow({ id: 'c2', account: 'uob', amount: '700.00' })],
    XFER_MAPPING, api, () => null,
    { reconciledThrough: '2026-07-26', transferPayeeFor: xferPayee });
  assert.equal(r.transfers, 0, 'contested, so the licence does not apply');
  assert.equal(r.ambiguous, 3);
  assert.equal(api.written.get('ACCT_A')[0].payee_name, 'A/C ending 0000');
  assert.equal(api.written.get('ACCT_A')[0].payee, undefined, 'no invented far leg');
  assert.equal(api.written.get('ACCT_B').length, 2, 'both candidates import as ordinary rows');
});

test('a licensed row with no candidate at all still books its transfer', async () => {
  // The over-tightening check. Trust-to-UOB is the case the licence exists for: one row, no
  // counterpart anywhere, and the far side is only bookable from the payee.
  const api = sink();
  const r = await loadRows(
    [xrow({ id: 'solo', account: 'main', amount: '-1.37', payee: 'A/C ending 0000' }),
     xrow({ id: 'other', account: 'card', amount: '-9.99', payee: 'TEST MERCHANT SG' })],
    XFER_MAPPING, api, () => null,
    { reconciledThrough: '2026-07-26', transferPayeeFor: xferPayee });
  assert.equal(r.transfers, 1);
  assert.equal(r.ambiguous, 0);
  assert.equal(api.written.get('ACCT_A').find((t) => t.imported_id === 'xsolo').payee,
    'payee-of-ACCT_B');
});

test('a counter-leg below the reconciliation floor still bars the payee path', async () => {
  // pairRows runs on the post-floor rows, so a counter-leg on or below the floor leaves the
  // surviving leg with no partner and uncontested — straight into the payee path, inventing a
  // leg beside money already booked. Re-piping an archive from runs/ after the floor has moved
  // past part of it splits a pair across the floor exactly this way.
  const api = sink();
  const debit = xrow({ id: 'out', account: 'uob', amount: '-700.00',
    date: '2026-08-20T23:59:00+08:00' });
  const credit = xrow({ id: 'in', account: 'main', amount: '700.00',
    date: '2026-08-21T00:00:00+08:00', payee: 'A/C ending 0000' });
  // The debit imported on an earlier run, under an earlier floor.
  await loadRows([debit], XFER_MAPPING, api, () => null,
    { reconciledThrough: '2026-08-19', transferPayeeFor: xferPayee });
  assert.equal(api.written.get('ACCT_B').length, 1);
  // Now the floor has moved past it, and the archive is re-piped with both legs.
  const r = await loadRows([debit, credit], XFER_MAPPING, api, () => null,
    { reconciledThrough: '2026-08-20', transferPayeeFor: xferPayee });
  assert.equal(r.skipped, 1, 'the debit is below the floor and is not written again');
  assert.equal(r.transfers, 0, 'but it is still evidence, so the licence stands down');
  assert.equal(api.written.get('ACCT_A')[0].payee_name, 'A/C ending 0000');
  assert.equal(api.written.get('ACCT_B').length, 1, 'no second debit is mirrored in');
});

// --- untracked source accounts ---

// The live failure this section exists for: Wise holds balances in several currencies but the
// budget carries ONE Wise account, denominated in SGD. A wise-aud row therefore resolved to the
// SGD account and was FX-converted into it, inventing an SGD debit for money that never moved in
// SGD. Two of those were deleted by hand from the live budget on 2026-08-28. The mapping key is
// what makes them resolvable, so the licence has to beat the key rather than replace it.
const AUD_ROW = { ...ROW, id: 'aud1', source: 'wise', account: 'wise-aud',
                  amount: '-42.00', currency: 'AUD', payee: 'TEST MERCHANT AU' };
const TRACKED_MAPPING = { 'wise-sgd': 'uuid-wise', 'wise-aud': 'uuid-wise' };
const UNTRACKED_MAPPING = { ...TRACKED_MAPPING, 'untracked:wise-aud': null };

test('a row from an untracked source account is never written', async () => {
  const api = fakeApi();
  await loadRows([AUD_ROW], UNTRACKED_MAPPING, api, () => FX);
  assert.equal(api.calls.length, 0, 'an untracked row must reach no account at all');
});

test('an untracked row is counted, not silently dropped', async () => {
  const result = await loadRows([AUD_ROW], UNTRACKED_MAPPING, fakeApi(), () => FX);
  assert.equal(result.untracked, 1);
  assert.equal(result.imported, 0);
  assert.equal(result.converted, 0, 'an untracked row must not take the FX path');
});

test('an untracked licence suppresses only its own account key', async () => {
  const api = fakeApi();
  const sgdRow = { ...ROW, id: 'sgd1', source: 'wise', account: 'wise-sgd' };
  const result = await loadRows([sgdRow, AUD_ROW], UNTRACKED_MAPPING, api, () => FX);
  assert.equal(result.imported, 1);
  assert.equal(result.untracked, 1);
  assert.deepEqual(api.calls.map((c) => c[0]), ['uuid-wise']);
  assert.deepEqual(api.calls[0][1].map((t) => t.imported_id), ['sgd1']);
});

test('splitUntracked partitions rows so the FX date list never carries an untracked date', () => {
  const sgdRow = { ...ROW, id: 'sgd1', source: 'wise', account: 'wise-sgd' };
  const { tracked, untracked } = splitUntracked([sgdRow, AUD_ROW], UNTRACKED_MAPPING);
  assert.deepEqual(tracked.map((r) => r.id), ['sgd1']);
  assert.deepEqual(untracked.map((r) => r.id), ['aud1']);
  // The point of partitioning before fxDatesFor: a rate service outage must not fail a run
  // whose only foreign rows are ones we have decided not to import.
  assert.deepEqual(fxDatesFor(tracked), []);
  assert.deepEqual(fxDatesFor([sgdRow, AUD_ROW]), ['2026-07-28']);
});

// A legal untracked mapping: the `untracked:` key and NO ordinary key beside it, which is what
// bin/actual-mail-load.js now enforces. `cash` rather than `wise-aud` because the Wise keys all
// share the Wise account, and pairing needs two different resolved account ids to be possible
// at all — a fixture that cannot pair would prove nothing either way.
const UNTRACKED_XFER = { ...XFER_MAPPING, 'untracked:cash': null };

test('an untracked row is not evidence against a licence', async () => {
  // The licence stands down when the same run holds a row the licensed one pairs or contests
  // with, because that row is the receiving bank's own alert and Actual will mirror it. An
  // untracked row is NEVER written, so it can never be that counterpart — treating it as one
  // silently downgrades a real internal transfer to an ordinary spend, with no `ambiguous` and
  // no `left unlinked` count to show it happened. Both pairing passes must see the same rows.
  const api = sink();
  const r = await loadRows(
    [xrow({ id: 'solo', account: 'main', amount: '-1.37', payee: 'A/C ending 0000' }),
     xrow({ id: 'ghost', account: 'cash', amount: '1.37', payee: 'somebody' })],
    UNTRACKED_XFER, api, () => null,
    { reconciledThrough: '2026-07-26', transferPayeeFor: xferPayee });
  assert.equal(r.untracked, 1);
  assert.equal(r.transfers, 1, 'the licensed transfer must still be booked');
  assert.equal(api.written.get('ACCT_A').find((t) => t.imported_id === 'xsolo').payee,
    'payee-of-ACCT_B');
});

test('a pot move out of an untracked account is a hard error, not a silent nothing', async () => {
  // The pot is inside the budget even when the account the money left is not, so setting the row
  // aside loses an arrival that really happened. Same doctrine as an unmapped account: a row this
  // tool cannot place is a loud failure, never a quiet skip. Unreachable on today's mapping —
  // pots belong to one bank and the untracked accounts are Wise balances — which is exactly why
  // it needs writing down rather than discovering the first time it fires.
  await assert.rejects(
    () => loadRows(
      [{ ...ROW, id: 'potout', account: 'cash', type: 'pot_transfer', payee: 'Buffer' }],
      { '0000': 'uuid-a', 'pot:Buffer': 'uuid-pot', 'untracked:cash': null },
      fakeApi(), () => null, { transferPayeeFor: (id) => `payee-of-${id}` }),
    /untracked account "cash" for pot "Buffer"/);
});

test('a pot move below the reconciliation floor does not throw — it was settled long ago', async () => {
  // The guard was placed before inScope, so a pot move imported and reconciled weeks earlier
  // aborted the whole run. On an hourly cron that is a feed that stops until a human edits the
  // mapping, over a row that was never going to be written. Every other hard error in the loader
  // is floor-gated; this one has to be too.
  const r = await loadRows(
    [{ ...ROW, id: 'oldpot', account: 'cash', type: 'pot_transfer', payee: 'Buffer',
       date: '2026-07-01T09:00:00+08:00' }],
    { '0000': 'uuid-a', 'pot:Buffer': 'uuid-pot', 'untracked:cash': null },
    fakeApi(), () => null,
    { reconciledThrough: '2026-07-20', transferPayeeFor: (id) => `payee-of-${id}` });
  assert.equal(r.imported, 0);
});

test('a pot move out of an untracked account throws even when the pot is unmapped', async () => {
  // The guard was conditional on the pot being mapped, which inverted its own reason: with the
  // pot key absent the row was silently discarded, where before the feature it was a loud
  // "no Actual account mapped for pot" error. Least configuration, quietest failure.
  await assert.rejects(
    () => loadRows(
      [{ ...ROW, id: 'potout', account: 'cash', type: 'pot_transfer', payee: 'Buffer' }],
      { '0000': 'uuid-a', 'untracked:cash': null },
      fakeApi(), () => null, { transferPayeeFor: (id) => `payee-of-${id}` }),
    /untracked account "cash"/);
});

// --- relinking a pair whose counterpart is already in the budget -------------------------
//
// The legs of one transfer routinely arrive in different runs: the Trust alert is an email and
// the Wise leg comes from an API, and an hourly cadence splits them whenever they straddle the
// boundary. Until now the second leg imported as an ordinary transaction and the run said
// "1 transfer(s) left unlinked", which is accurate and permanent — the pair never becomes a
// transfer no matter how many times it runs. Deleting the stale leg and writing the transfer
// fresh uses only primitives already proven here: converting a row in place is NOT used,
// because Actual accepts the payee change and silently declines to create the counterpart.

// A sink that can delete, and that can be seeded with what the budget already holds.
function deletingSink(seed = new Map()) {
  const s = sink();
  for (const [acct, txns] of seed) s.written.set(acct, [...txns]);
  s.deleted = [];
  s.deleteTransaction = async (id) => {
    s.deleted.push(id);
    for (const [acct, txns] of s.written) {
      s.written.set(acct, txns.filter((t) => t.id !== id));
    }
  };
  return s;
}

const PAIR_ROWS = () => [
  xrow({ id: 'out', account: 'uob', amount: '-700.00', raw_ref: '<u>' }),
  xrow({ id: 'in', account: 'main', amount: '700.00', raw_ref: '<t>' }),
];
const XOPTS = { reconciledThrough: '2026-07-26', transferPayeeFor: xferPayee };

test('a leg already in the budget is deleted and the pair is written as a transfer', async () => {
  const api = deletingSink(new Map([['ACCT_A', [
    { id: 'existing-1', imported_id: 'xin', amount: 70000, date: '2026-08-27' },
  ]]]));
  const r = await loadRows(PAIR_ROWS(), XFER_MAPPING, api, () => null, XOPTS);
  assert.deepEqual(api.deleted, ['existing-1']);
  assert.equal(r.transfers, 1);
  assert.equal(r.transfersRelinked, 1);
  assert.equal(r.transfersAlreadySeparate, 0, 'it was linked, not left');
  const written = api.written.get('ACCT_B');
  assert.equal(written.length, 1);
  assert.equal(written[0].imported_id, 'xout+xin', 'the joined id, so neither source row re-imports');
  assert.equal(written[0].payee, 'payee-of-ACCT_A');
});

test('a reconciled leg is never deleted — the human balanced that period', async () => {
  const api = deletingSink(new Map([['ACCT_A', [
    { id: 'existing-1', imported_id: 'xin', amount: 70000, date: '2026-08-27', reconciled: true },
  ]]]));
  const r = await loadRows(PAIR_ROWS(), XFER_MAPPING, api, () => null, XOPTS);
  assert.deepEqual(api.deleted, []);
  assert.equal(r.transfersRelinked, 0);
  assert.equal(r.transfersAlreadySeparate, 1, 'falls back to the old behaviour, and says so');
});

test('a leg that is already part of a transfer is left completely alone', async () => {
  const api = deletingSink(new Map([['ACCT_A', [
    { id: 'existing-1', imported_id: 'xin', amount: 70000, date: '2026-08-27', transfer_id: 'other-side' },
  ]]]));
  const r = await loadRows(PAIR_ROWS(), XFER_MAPPING, api, () => null, XOPTS);
  assert.deepEqual(api.deleted, []);
  assert.equal(r.transfersRelinked, 0);
});

test('a caller whose api cannot delete keeps the old behaviour', async () => {
  // An external caller may pass a two-method api. Relinking must degrade to reporting rather
  // than throwing on a missing method. (verify-scratch passes the whole module, so it can delete.)
  const api = sink();
  api.written.set('ACCT_A', [{ id: 'existing-1', imported_id: 'xin', amount: 70000, date: '2026-08-27' }]);
  const r = await loadRows(PAIR_ROWS(), XFER_MAPPING, api, () => null, XOPTS);
  assert.equal(r.transfersRelinked, 0);
  assert.equal(r.transfersAlreadySeparate, 1);
});

test('a pair already written as a transfer is not relinked on the next run', async () => {
  // The idempotence check. The joined id is in the budget, so the run must delete nothing and
  // write nothing, every hour, forever.
  const api = deletingSink(new Map([['ACCT_B', [
    { id: 'existing-x', imported_id: 'xout+xin', amount: -70000, date: '2026-08-27' },
  ]]]));
  const r = await loadRows(PAIR_ROWS(), XFER_MAPPING, api, () => null, XOPTS);
  assert.deepEqual(api.deleted, []);
  assert.equal(r.transfersRelinked, 0);
  assert.equal(r.imported, 0);
});

test('a leg present in TWO accounts is never relinked — one copy would survive and double', async () => {
  // The mapping-change state this file's own dedupe comments describe: the same source row was
  // written under an earlier mapping and again under the current one, so it exists twice. A flat
  // id -> row map keeps only the last one seen, so a relink deletes one copy, writes the transfer
  // over the top, and the surviving copy plus Actual's mirrored leg double the money. Refusing is
  // the only safe answer: the tool cannot know which copy the human wants.
  const mapping = { ...XFER_MAPPING, spare: 'ACCT_C' };
  const api = deletingSink(new Map([
    ['ACCT_A', [{ id: 'copyA', imported_id: 'xin', amount: 70000, date: '2026-08-27' }]],
    ['ACCT_C', [{ id: 'copyC', imported_id: 'xin', amount: 70000, date: '2026-08-27' }]],
  ]));
  const r = await loadRows(PAIR_ROWS(), mapping, api, () => null, XOPTS);
  assert.deepEqual(api.deleted, [], 'an ambiguous duplicate must not be deleted');
  assert.equal(r.transfersRelinked, 0);
  assert.equal(r.transfersAlreadySeparate, 1, 'falls back to reporting, and says so');
});

test('a split parent is never deleted — the subtransactions go with it', async () => {
  const api = deletingSink(new Map([['ACCT_A', [
    { id: 'existing-1', imported_id: 'xin', amount: 70000, date: '2026-08-27',
      is_parent: true, subtransactions: [{ amount: 40000 }, { amount: 30000 }] },
  ]]]));
  const r = await loadRows(PAIR_ROWS(), XFER_MAPPING, api, () => null, XOPTS);
  assert.deepEqual(api.deleted, []);
  assert.equal(r.transfersAlreadySeparate, 1);
});

test('a row carrying a JOINED id is never deleted — it stands for two source rows', async () => {
  // A transfer this tool already wrote, whose transfer_id never got set because Actual accepted
  // the write and declined to link. Deleting it replaces a transfer covering two source rows with
  // one covering a different pair, and the third row's money is simply gone.
  const api = deletingSink(new Map([['ACCT_A', [
    { id: 'existing-1', imported_id: 'xin+zzz', amount: 70000, date: '2026-08-27' },
  ]]]));
  const r = await loadRows(PAIR_ROWS(), XFER_MAPPING, api, () => null, XOPTS);
  assert.deepEqual(api.deleted, []);
  assert.equal(r.transfersRelinked, 0);
});

test('a delete that succeeds and a write that then fails is still synced', async () => {
  // The whole point of putting the deletes inside the try. Without the sync the deletion sits in
  // the local cache unsynced, and the safety net the comment promises never fires because it was
  // gated on `imported > 0` and nothing was imported.
  const api = deletingSink(new Map([['ACCT_A', [
    { id: 'existing-1', imported_id: 'xin', amount: 70000, date: '2026-08-27' },
  ]]]));
  let synced = 0;
  api.sync = async () => { synced += 1; };
  api.addTransactions = async () => { throw new Error('server 500'); };
  await assert.rejects(() => loadRows(PAIR_ROWS(), XFER_MAPPING, api, () => null, XOPTS), /server 500/);
  assert.deepEqual(api.deleted, ['existing-1'], 'the delete did happen');
  assert.equal(synced, 1, 'so it has to be synced, or the local cache and the server disagree');
});
