import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, toJsonl } from '../src/output.js';

const ROW = {
  id: 'abc', source: 'trust', account: '0000', date: '2026-07-28T07:24:00+08:00',
  amount: '-3.18', currency: 'SGD', payee: 'TEST MERCHANT SG',
  type: 'card', raw_ref: '<a@b>',
};

test('toCsv emits a header then one line per row', () => {
  const out = toCsv([ROW]);
  const lines = out.trim().split('\n');
  assert.equal(lines[0], 'id,source,account,date,amount,currency,payee,type,raw_ref');
  assert.ok(lines[1].startsWith('abc,trust,0000,'));
  assert.equal(lines.length, 2);
});

test('toCsv quotes fields containing a comma or a quote', () => {
  const out = toCsv([{ ...ROW, payee: 'ACME, INC "HQ"' }]);
  assert.ok(out.includes('"ACME, INC ""HQ"""'));
});

test('toCsv on an empty list still emits the header', () => {
  assert.equal(toCsv([]).trim(), 'id,source,account,date,amount,currency,payee,type,raw_ref');
});

test('toJsonl emits one parseable object per line', () => {
  const out = toJsonl([ROW, ROW]).trim().split('\n');
  assert.equal(out.length, 2);
  assert.equal(JSON.parse(out[0]).payee, 'TEST MERCHANT SG');
});

// run.sh decides whether to overwrite the day's archive with `[ -s "$TMPOUT" ]`, so
// "no rows" has to be zero bytes and not a bare newline. It returned '\n' until
// 2026-07-29, which made a run that extracted nothing indistinguishable from a run that
// extracted something — and would have replaced a good archive with a blank line.
test('toJsonl on an empty list is zero bytes, not a bare newline', () => {
  assert.equal(toJsonl([]), '');
});
