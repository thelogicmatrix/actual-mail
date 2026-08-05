import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collect, main } from '../src/cli.js';

const parse = (text, ref) => {
  if (text.includes('SPEND')) return { id: ref, amount: '-1.00', date: '2026-01-01' };
  if (text.includes('NOISE')) return { ignored: true, reason: 'subject' };
  return null;
};

async function* messages() {
  yield { messageId: '<1>', subject: 'a', text: 'SPEND' };
  yield { messageId: '<2>', subject: 'payee added', text: 'NOISE' };
  yield { messageId: '<3>', subject: 'brand new format', text: 'MYSTERY' };
}

test('collect separates rows, ignored, and unparsed', async () => {
  const { rows, unparsed, ignored } = await collect(messages(), parse);
  assert.equal(rows.length, 1);
  assert.equal(ignored, 1);
  assert.equal(unparsed.length, 1);
  assert.equal(unparsed[0].messageId, '<3>');
});

test('every message is accounted for — nothing silently vanishes', async () => {
  const { rows, unparsed, ignored } = await collect(messages(), parse);
  assert.equal(rows.length + ignored + unparsed.length, 3);
});

test('an empty mailbox is not an error', async () => {
  async function* none() {}
  const { rows, unparsed } = await collect(none(), parse);
  assert.deepEqual(rows, []);
  assert.deepEqual(unparsed, []);
});

test("an unparsed record carries the Message-ID and NOT the bank's subject", async () => {
  // The subject used to be carried here and written to stderr, which becomes the body of a
  // webhook alert -- and a bank's alert subject carries the amount and often the merchant. So the
  // one place data left the host was posting transaction detail to a third party that keeps it
  // indefinitely, on the failure that happens in normal operation. The Message-ID locates the
  // mail in your own mailbox, where the subject already is.
  const { unparsed } = await collect(messages(), parse);
  assert.ok(unparsed[0].messageId, 'a Message-ID is needed to locate the mail');
  assert.equal(unparsed[0].subject, undefined, "the bank's subject must not be carried");
});

// A source that cannot be reached used to end the process as an unhandled rejection, before
// stdout was written — so on 2026-07-29 a Wise DNS blip discarded the Trust rows that had
// already parsed. Reported and non-zero, but never fatal.
test('an unreachable source is reported, not thrown', async () => {
  const realFetch = globalThis.fetch;
  const realExitCode = process.exitCode;
  const realWrite = process.stderr.write.bind(process.stderr);
  const written = [];
  process.stderr.write = (s) => { written.push(String(s)); return true; };
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  try {
    await main(['--source', 'wise', '--format', 'jsonl', '--since', '2026-07-20']);
    assert.equal(process.exitCode, 1, 'a failed source still has to alert');
    assert.ok(
      written.some((s) => s.startsWith('SOURCE FAILED wise:')),
      `stderr must name the source that failed, got ${JSON.stringify(written)}`,
    );
  } finally {
    process.stderr.write = realWrite;
    globalThis.fetch = realFetch;
    process.exitCode = realExitCode;
  }
});

// --- a parser that THROWS must not discard the batch around it ---------------------------
// This is the hole the "nothing silently vanishes" test above could not see: its stub parser
// returns null for the unrecognised case and cannot throw, so the loop's real failure mode —
// an exception escaping mid-iteration — was never exercised. Two live throws reach it: an
// unexpected month name in trust-sg, and a message with no Message-ID.

const throwingParse = (text, ref) => {
  if (text.includes('BOOM')) throw new RangeError('unknown month: JAN');
  if (text.includes('SPEND')) return { id: ref, amount: '-1.00', date: '2026-01-01' };
  return null;
};

const msgs = (...texts) => texts.map((text, i) => ({
  text, messageId: `<m${i}@x>`, subject: `subject ${i}`,
}));

test('a throwing message does not discard the rows extracted beside it', async () => {
  const r = await collect(msgs('SPEND one', 'BOOM', 'SPEND three'), throwingParse);
  assert.equal(r.rows.length, 2, 'both good rows survive the throw between them');
  assert.deepEqual(r.rows.map((x) => x.id), ['<m0@x>', '<m2@x>']);
});

test('a throwing message is reported as unparsed, naming itself and the error', async () => {
  const r = await collect(msgs('BOOM'), throwingParse);
  assert.equal(r.unparsed.length, 1);
  assert.equal(r.unparsed[0].messageId, '<m0@x>');
  assert.match(r.unparsed[0].note, /parser threw: unknown month: JAN/);
  assert.equal(r.unparsed[0].subject, undefined, "our note, never the bank's subject");
});

test('a throw routes to unparsed, NOT to a source failure', async () => {
  // Routing matters as much as not losing the rows: `SOURCE FAILED` is the class run.sh holds
  // for three runs as self-healing, and a message stuck in the mailbox never heals. The
  // unparsed path is deliberately not streak-gated.
  const r = await collect(msgs('BOOM'), throwingParse);
  assert.equal(r.rows.length, 0);
  assert.equal(r.ignored, 0);
  assert.equal(r.unparsed.length, 1, 'the message is named on the unparsed channel');
});

// --- an unknown flag value must not be reported as a healthy empty run ------------------

test('an unknown --source exits non-zero instead of writing an empty file', async () => {
  const errs = [];
  const write = process.stderr.write;
  const out = process.stdout.write;
  process.stderr.write = (s) => { errs.push(s); return true; };
  process.stdout.write = () => true;
  process.exitCode = 0;
  try {
    await main(['--source', 'dbs']);
  } finally {
    process.stderr.write = write;
    process.stdout.write = out;
  }
  const code = process.exitCode;
  process.exitCode = 0;
  assert.equal(code, 1, 'a typo must not exit 0');
  assert.match(errs.join(''), /unknown --source "dbs"/);
  assert.match(errs.join(''), /trust-sg/, 'the message lists the ids that would have worked');
});

test('an unknown --format exits non-zero rather than silently falling back to csv', async () => {
  const errs = [];
  const write = process.stderr.write;
  const out = process.stdout.write;
  process.stderr.write = (s) => { errs.push(s); return true; };
  process.stdout.write = () => true;
  process.exitCode = 0;
  try {
    await main(['--source', 'wise', '--format', 'json']);
  } finally {
    process.stderr.write = write;
    process.stdout.write = out;
  }
  const code = process.exitCode;
  process.exitCode = 0;
  assert.equal(code, 1);
  assert.match(errs.join(''), /unknown --format "json"/);
});

test('an unparseable --since is refused before any source is contacted', async () => {
  const errs = [];
  const write = process.stderr.write;
  process.stderr.write = (s) => { errs.push(s); return true; };
  process.exitCode = 0;
  try {
    await main(['--since', 'yesterday']);
  } finally {
    process.stderr.write = write;
  }
  const code = process.exitCode;
  process.exitCode = 0;
  assert.equal(code, 1);
  assert.match(errs.join(''), /--since "yesterday" is not a date/);
});
