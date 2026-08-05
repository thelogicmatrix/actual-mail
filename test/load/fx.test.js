import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseCurrency, makeRateLookup, fetchRates, markupFor, DEFAULT_MARKUP } from '../../src/load/fx.js';

test('base currency defaults to SGD', () => {
  delete process.env.BASE_CURRENCY;
  assert.equal(baseCurrency(), 'SGD');
});

test('base currency comes from the environment', () => {
  process.env.BASE_CURRENCY = 'GBP';
  assert.equal(baseCurrency(), 'GBP');
  delete process.env.BASE_CURRENCY;
});

test('a row in the base currency needs no rate, whatever the base is', () => {
  const lookup = makeRateLookup(new Map(), 0.003, 'GBP');
  assert.equal(lookup('2026-08-01', 'GBP'), null);
});

test('a row NOT in the base currency does need a rate', () => {
  const rateMap = new Map([['2026-08-01', { rates: { SGD: 1.7 }, rateDate: '2026-08-01' }]]);
  const lookup = makeRateLookup(rateMap, 0, 'GBP');
  const fx = lookup('2026-08-01', 'SGD');
  assert.ok(fx, 'SGD should be foreign when the base is GBP');
  assert.ok(Math.abs(fx.rate - 1 / 1.7) < 1e-9);
});

// --- the markup is per-source -----------------------------------------------------------

test('an API source that reports the currency it holds gets no markup', () => {
  assert.equal(markupFor('wise'), 0);
  assert.equal(markupFor('wise', 0.02), 0);
});

test('an alert-derived source keeps the configured markup', () => {
  assert.equal(markupFor('trust'), DEFAULT_MARKUP);
  assert.equal(markupFor('trust', 0.02), 0.02, 'FX_MARKUP stays the knob');
  assert.equal(markupFor(null), DEFAULT_MARKUP, 'an unknown source is assumed to carry a spread');
});

test('the rate lookup applies the per-source markup', () => {
  const rateMap = new Map([['2026-08-01', { rates: { GBP: 0.58 }, rateDate: '2026-08-01' }]]);
  const lookup = makeRateLookup(rateMap, 0.003);
  assert.equal(lookup('2026-08-01', 'GBP', 'wise').markup, 0);
  assert.equal(lookup('2026-08-01', 'GBP', 'trust').markup, 0.003);
});

test('fetchRates requests the configured base, not a hardcoded one', async () => {
  const seen = [];
  const fake = async (url) => {
    seen.push(url);
    return { ok: true, json: async () => ({ rates: { SGD: 1.7 }, date: '2026-08-01' }) };
  };
  await fetchRates(['2026-08-01'], fake, 'GBP');
  assert.ok(seen[0].endsWith('base=GBP'), `expected base=GBP, got ${seen[0]}`);
});

// Asserts the abort signal is passed, not that a wall-clock timeout elapses: a test that waited
// 15 seconds to prove a 15-second bound would be the slowest test in the suite and would still
// only prove the default. What can silently regress is the argument going missing.
test('fetchRates bounds the request, so a quiet socket cannot hang the loader', async () => {
  let opts;
  const fake = async (_url, o) => {
    opts = o;
    return { ok: true, json: async () => ({ rates: { SGD: 1.7 }, date: '2026-08-01' }) };
  };
  await fetchRates(['2026-08-01'], fake);
  assert.ok(opts?.signal, 'no abort signal reached fetch — an unbounded call holds the flock');
  assert.equal(typeof opts.signal.aborted, 'boolean', 'the signal should be a real AbortSignal');
});
