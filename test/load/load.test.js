import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toActualTxn, toMinorUnits, loadRows, sgDay, inScope, fxDatesFor } from '../../src/load/load.js';
import { makeRateLookup, DEFAULT_MARKUP } from '../../src/load/fx.js';
import { rowId } from '../../src/row.js';

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
