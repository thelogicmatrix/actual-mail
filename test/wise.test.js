import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wiseRows, fetchWise } from '../src/sources/wise.js';

// Field names confirmed against the live API 2026-07-28 by probing it (scripts/probe-wise.js),
// since Wise's published docs are JS-rendered and return nothing to a plain fetch.
const STATEMENT = {
  transactions: [
    { referenceNumber: 'TRX-1', date: '2026-07-26T10:48:50.000Z', type: 'DEBIT',
      amount: { value: -275.60, currency: 'SGD' }, totalFees: { value: 0, currency: 'SGD' },
      details: { description: 'Sent money to ACME LTD' } },
    { referenceNumber: 'TRX-2', date: '2026-07-20T02:00:00.000Z', type: 'CREDIT',
      amount: { value: 1000.00, currency: 'SGD' }, totalFees: { value: 0, currency: 'SGD' },
      details: { description: 'Received money' } },
  ],
};

test('maps debits and credits, preserving sign', () => {
  const rows = wiseRows(STATEMENT, 'wise-sgd');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].amount, '-275.60');
  assert.equal(rows[1].amount, '1000.00');
});

test('amounts are strings with two decimal places', () => {
  for (const r of wiseRows(STATEMENT, 'wise-sgd')) {
    assert.equal(typeof r.amount, 'string');
    assert.match(r.amount, /^-?\d+\.\d{2}$/);
  }
});

test('row id derives from the Wise reference, not the array position', () => {
  const a = wiseRows(STATEMENT, 'wise-sgd')[0];
  const b = wiseRows({ transactions: [STATEMENT.transactions[0]] }, 'wise-sgd')[0];
  assert.equal(a.id, b.id);
});

test('the account label is carried through, so each balance is a distinct account', () => {
  assert.equal(wiseRows(STATEMENT, 'wise-aud')[0].account, 'wise-aud');
});

test('currency comes from the transaction, never assumed', () => {
  const aud = { transactions: [{ ...STATEMENT.transactions[0],
    amount: { value: -10, currency: 'AUD' } }] };
  assert.equal(wiseRows(aud, 'wise-aud')[0].currency, 'AUD');
});

test('an empty statement yields no rows', () => {
  assert.deepEqual(wiseRows({ transactions: [] }, 'wise-sgd'), []);
});

test('a statement with no transactions key yields no rows', () => {
  assert.deepEqual(wiseRows({}, 'wise-sgd'), []);
});

test('a missing description does not produce an empty payee', () => {
  const bare = { transactions: [{ referenceNumber: 'X', date: '2026-07-01T00:00:00.000Z',
    amount: { value: -1, currency: 'SGD' } }] };
  assert.equal(wiseRows(bare, 'wise-sgd')[0].payee, '(no description)');
});

test('dates are ISO 8601', () => {
  assert.match(wiseRows(STATEMENT, 'wise-sgd')[0].date, /^\d{4}-\d{2}-\d{2}T/);
});

// --- transport ------------------------------------------------------------------------
// A DNS EAI_AGAIN from the LAN resolver killed a whole run on 2026-07-29. Node surfaces it
// as `TypeError: fetch failed`, which is a rejection rather than a response, so none of the
// res.ok handling above ever saw it.

// Serves the three shapes fetchWise walks: profiles, balances, then a statement per balance.
function wiseApi(url) {
  if (url.endsWith('/v1/profiles')) return [{ id: 42, type: 'personal' }];
  if (url.includes('/balances?')) return [{ id: 7, currency: 'SGD' }];
  return STATEMENT;
}

function stubFetch(handler) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = real; };
}

// The retry window is 1s + 2s + 4s of real sleeping, and a suite that takes seven seconds to
// prove a loop counts is a suite that stops being run. The backoff arithmetic itself is
// asserted in retry.test.js; here only the attempt counts matter.
function stubSleep() {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => real(fn, 0);
  return () => { globalThis.setTimeout = real; };
}

test('a transient network failure is retried rather than fatal', async () => {
  let attempts = 0;
  const unsleep = stubSleep();
  const restore = stubFetch(async (url) => {
    attempts += 1;
    if (attempts === 1) throw new TypeError('fetch failed');
    return { ok: true, status: 200, json: async () => wiseApi(url) };
  });
  try {
    const rows = await fetchWise({ token: 't', since: '2026-07-20', until: '2026-07-28' });
    assert.equal(rows.length, 2, 'the retried call must still deliver its rows');
    assert.ok(attempts > 1, 'the failed attempt must have been retried');
  } finally { restore(); unsleep(); }
});

test('retries are bounded — a real outage still fails, naming the cause', async () => {
  let attempts = 0;
  const unsleep = stubSleep();
  const restore = stubFetch(async () => {
    attempts += 1;
    throw new TypeError('fetch failed');
  });
  try {
    await assert.rejects(
      () => fetchWise({ token: 't', since: '2026-07-20' }),
      /unreachable after \d+ attempts/,
      'the raw undici stack is unreadable in a Discord alert; the message has to say what broke',
    );
    assert.ok(attempts <= 5, `bounded, not a hang: ${attempts} attempts`);
  } finally { restore(); unsleep(); }
});

test('an HTTP error is NOT retried — a 403 allowlist does not heal in a second', async () => {
  let attempts = 0;
  const restore = stubFetch(async () => {
    attempts += 1;
    return { ok: false, status: 403, json: async () => ({}) };
  });
  try {
    await assert.rejects(() => fetchWise({ token: 't', since: '2026-07-20' }), /403/);
    assert.equal(attempts, 1, 'retrying a 403 only delays the report of a real problem');
  } finally { restore(); }
});
