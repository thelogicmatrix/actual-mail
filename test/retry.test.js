import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retry, isTransient, ATTEMPTS } from '../src/retry.js';

// baseMs: 0 throughout. The real policy waits 1s + 2s + 4s, and a suite that takes seven
// seconds to prove a retry loop counts is a suite that stops being run.
const FAST = { baseMs: 0 };

// The three shapes the failure actually arrives in. Undici buries a SystemError inside
// `TypeError: fetch failed`; imapflow gave us the code in the message and nowhere else.
const nested = () => new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'EAI_AGAIN' }) });
const coded = () => Object.assign(new Error('connect failed'), { code: 'ECONNRESET' });
const messageOnly = () => new Error('getaddrinfo EAI_AGAIN imap.gmail.com');

test('every observed shape of a DNS blip reads as transient', () => {
  for (const make of [nested, coded, messageOnly]) assert.ok(isTransient(make()), make.name);
});

test('a credential failure is NOT transient — retrying it four times locks the mailbox', () => {
  assert.equal(isTransient(new Error('Invalid credentials (Failure)')), false);
  assert.equal(isTransient(Object.assign(new Error('nope'), { code: 'AUTHENTICATIONFAILED' })), false);
});

test('a transient failure is retried and the eventual value is returned', async () => {
  let calls = 0;
  const value = await retry(async () => {
    calls += 1;
    if (calls < 3) throw messageOnly();
    return 'connected';
  }, FAST);
  assert.equal(value, 'connected');
  assert.equal(calls, 3, 'both blips must have been ridden out, not just the first');
});

test('a non-transient failure is thrown on the first attempt, not seven seconds later', async () => {
  let calls = 0;
  await assert.rejects(() => retry(async () => {
    calls += 1;
    throw new Error('Invalid credentials');
  }, FAST), /Invalid credentials/);
  assert.equal(calls, 1);
});

test('retries are bounded — a real outage still fails, and does not hang', async () => {
  let calls = 0;
  await assert.rejects(() => retry(async () => {
    calls += 1;
    throw messageOnly();
  }, FAST), /EAI_AGAIN/);
  assert.equal(calls, ATTEMPTS);
});

test('the delay grows per attempt — three 1s tries did not outlast the 2026-08-01 blip', async () => {
  const waited = [];
  const sleep = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => { waited.push(ms); return sleep(fn, 0); };
  try {
    await assert.rejects(() => retry(async () => { throw messageOnly(); }), /EAI_AGAIN/);
  } finally { globalThis.setTimeout = sleep; }
  assert.deepEqual(waited, [1000, 2000, 4000], 'the window has to widen, not repeat');
});
