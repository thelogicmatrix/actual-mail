// The loader entrypoint had no behavioural test of any kind: `grep -rn 'actual-mail-load' test/`
// returned one hit and it was `docker run --help`, and scripts/test-run-sh.sh stubs the binary
// out entirely. Four fixes in that file are each documented as preventing a silent money loss —
// the sync before the success line, the stdin validator, the FX_MARKUP bounds, the reconciliation
// floor guard — and nothing pinned any of them. These run the real binary.
//
// Everything here that stops at a validation exits before api.init, so it needs no server. The
// two cases that must run the whole thing swap the Actual client for a stub through a module
// resolve hook (see STUB below); the alternative was a test seam in the money path itself, which
// is an env-controlled `import()` in a tool that writes to a real budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/actual-mail-load.js', import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), 'actual-mail-load-'));

// Carries a LIVE no-inbound-alert licence, not just a complete account list: the four-digit shape
// test below has a happy path, and without a valid licence here nothing would fail if that test
// started rejecting one. 'a complete mapping says nothing about licences' passed vacuously before
// this key existed, because there was no licence in the file to say anything about.
const MAPPING = join(TMP, 'mapping.json');
writeFileSync(MAPPING, JSON.stringify({
  '0000': '00000000-0000-0000-0000-00000000000a',
  card: '00000000-0000-0000-0000-00000000000b',
  'no-inbound-alert:0000': '00000000-0000-0000-0000-00000000000a',
}));

// A mapping deliberately missing the row's account, for the leak test below. Kept separate so
// the main MAPPING stays complete for every other test. The account placeholder is all-zeros
// throughout, per the convention in scripts/scan-pii.js: any other four-digit literal is
// indistinguishable from a real account number to the gate, and rightly trips it.
const MAPPING_EMPTY = join(TMP, 'mapping-empty.json');
writeFileSync(MAPPING_EMPTY, JSON.stringify({
  card: '00000000-0000-0000-0000-00000000000b',
}));

// A `no-inbound-alert:` licence whose bare account key is absent. loadRows resolves a
// payee-named account through the ordinary key first, so this licence can never fire: the entry
// looks live in the file and silently does nothing.
// An `untracked:` source account WITHOUT an ordinary key for it. That is the shape the
// completeness check has to learn: the row's account is genuinely absent from the mapping, and
// before this it exited 1 naming a key the operator deliberately did not write.
const MAPPING_UNTRACKED = join(TMP, 'mapping-untracked.json');
writeFileSync(MAPPING_UNTRACKED, JSON.stringify({
  '0000': '00000000-0000-0000-0000-00000000000a',
  card: '00000000-0000-0000-0000-00000000000b',
  'no-inbound-alert:0000': '00000000-0000-0000-0000-00000000000a',
  'untracked:wise-aud': null,
}));

// A one-character slip in the prefix. The ordinary `wise-aud` key is still present — the state
// the README recommends — so without a guard the row imports, takes the FX path and invents an
// SGD debit, with the run reporting success. There is no fuzzy match for this; what makes it
// catchable is that the mapping has exactly three legal prefixes and this is not one of them.
const MAPPING_TYPO_PREFIX = join(TMP, 'mapping-typo-prefix.json');
writeFileSync(MAPPING_TYPO_PREFIX, JSON.stringify({
  '0000': '00000000-0000-0000-0000-00000000000a',
  'wise-aud': '00000000-0000-0000-0000-00000000000c',
  'untraked:wise-aud': null,
}));

// An `untracked:` key carrying an account id instead of null. The row is still set aside, so the
// value is load-bearing for nothing except the dedupe read, where it makes the loader ask Actual
// for the transactions of an account that need not exist.
const MAPPING_UNTRACKED_VALUE = join(TMP, 'mapping-untracked-value.json');
writeFileSync(MAPPING_UNTRACKED_VALUE, JSON.stringify({
  '0000': '00000000-0000-0000-0000-00000000000a',
  'untracked:wise-aud': '00000000-0000-0000-0000-00000000000c',
}));

// `untracked:` over a pot target. splitUntracked matches a row's source account only, so this
// key can never fire and excludes nothing — and a pot move is two-sided anyway, so wanting to
// exclude one side of it is already a contradiction.
const MAPPING_UNTRACKED_POT = join(TMP, 'mapping-untracked-pot.json');
writeFileSync(MAPPING_UNTRACKED_POT, JSON.stringify({
  '0000': '00000000-0000-0000-0000-00000000000a',
  'pot:Buffer': '00000000-0000-0000-0000-00000000000d',
  'untracked:pot:Buffer': null,
}));

// An `untracked:` key beside the ordinary key for the same account. "The licence beats the
// ordinary key" was the original design and it is not enough: `namedAccount` resolves a payee
// through `mapping[<four digits>]` and never consults the licence, so the account stays a legal
// TARGET for an invented transfer leg even though its own rows are being set aside.
const MAPPING_UNTRACKED_COEXIST = join(TMP, 'mapping-untracked-coexist.json');
writeFileSync(MAPPING_UNTRACKED_COEXIST, JSON.stringify({
  '0000': '00000000-0000-0000-0000-00000000000a',
  'untracked:0000': null,
}));

const MAPPING_ORPHAN_LICENCE = join(TMP, 'mapping-orphan-licence.json');
writeFileSync(MAPPING_ORPHAN_LICENCE, JSON.stringify({
  card: '00000000-0000-0000-0000-00000000000b',
  'no-inbound-alert:0000': '00000000-0000-0000-0000-00000000000a',
}));

// The other inert shape, and the one a presence test cannot see. `namedAccount` only ever returns
// a four-digit group, so a licence over a named key is unreachable even though the key is mapped.
const MAPPING_NAMED_LICENCE = join(TMP, 'mapping-named-licence.json');
writeFileSync(MAPPING_NAMED_LICENCE, JSON.stringify({
  card: '00000000-0000-0000-0000-00000000000b',
  main: '00000000-0000-0000-0000-00000000000a',
  'no-inbound-alert:main': '00000000-0000-0000-0000-00000000000a',
}));

// A valid row, dated well after any floor these tests set.
const ROW = {
  id: 'row-1', source: 'trust', account: '0000', date: '2026-07-28T07:24:00+08:00',
  amount: '-3.18', currency: 'SGD', payee: 'TEST MERCHANT SG', type: 'card', raw_ref: '<a@b>',
};

// --- the Actual client, stubbed through a resolve hook ---------------------------------
const STUB = join(TMP, 'stub-actual.mjs');
writeFileSync(STUB, `
export const init = async () => {};
export const downloadBudget = async () => {};
// Transfer payees for the two mapped accounts, so a pair can actually be booked. Without them
// the loader refuses with "no transfer payee", which is correct but means no test here could
// ever reach the transfer path at all.
export const getPayees = async () => [
  { id: 'xfer-a', name: 'A', transfer_acct: '00000000-0000-0000-0000-00000000000a' },
  { id: 'xfer-b', name: 'B', transfer_acct: '00000000-0000-0000-0000-00000000000b' },
];
// Seeded with what the budget already holds, so a test can drive the relink path: a pair whose
// counterpart is already a transaction. STUB_DELETES records every deletion, which is how the
// dry-run test proves a rehearsal deletes nothing.
export const getTransactions = async (accountId) =>
  JSON.parse(process.env.STUB_EXISTING || '{}')[accountId] || [];
export const addTransactions = async (id, txns) => txns.map((t) => t.imported_id);
export const updateTransaction = async (id, fields) => {
  if (process.env.STUB_UPDATES) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.STUB_UPDATES, id + ':' + JSON.stringify(fields) + String.fromCharCode(10));
  }
};
export const deleteTransaction = async (id) => {
  if (process.env.STUB_DELETES) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.STUB_DELETES, id + String.fromCharCode(10));
  }
};
export const sync = async () => {
  if (process.env.STUB_SYNC_FAIL === '1') throw new Error('stub: sync rejected');
};
export const shutdown = async () => {};
`);
const RESOLVE = join(TMP, 'resolve.mjs');
writeFileSync(RESOLVE, `
export async function resolve(specifier, context, next) {
  if (specifier === '@actual-app/api') return { url: ${JSON.stringify(pathToFileURL(STUB).href)}, shortCircuit: true };
  return next(specifier, context);
}
`);
const HOOKS = join(TMP, 'hooks.mjs');
writeFileSync(HOOKS, `
import { register } from 'node:module';
register(${JSON.stringify(pathToFileURL(RESOLVE).href)});
`);

// Base env is built by deletion, not by spreading process.env wholesale: a BASE_CURRENCY or an
// FX_MARKUP exported in the shell running `npm test` would otherwise change what these assert.
function run(lines, env = {}, { stub = false } = {}) {
  const base = { ...process.env };
  for (const k of Object.keys(base)) {
    if (k.startsWith('ACTUAL_') || k === 'FX_MARKUP' || k === 'BASE_CURRENCY' || k === 'STUB_SYNC_FAIL') {
      delete base[k];
    }
  }
  const input = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
  // A file:// URL, not the bare path: --import goes through the ESM loader, which reads
  // `C:\...` as protocol "c:".
  return spawnSync(process.execPath, [...(stub ? ['--import', pathToFileURL(HOOKS).href] : []), BIN], {
    input,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...base,
      ACTUAL_MAIL_MAPPING: MAPPING,
      ACTUAL_SERVER_URL: 'http://127.0.0.1:1',
      ACTUAL_PASSWORD: 'server-pw',
      ACTUAL_SYNC_ID: 'sync-id',
      ACTUAL_BUDGET_PASSWORD: 'budget-pw',
      ACTUAL_DATA_DIR: join(TMP, 'cache'),
      ACTUAL_MAIL_DRY_RUN: '1',
      ...env,
    },
  });
}

// --- the stdin validator ---------------------------------------------------------------
//
// stdin is a trust boundary: the README invites these rows through other tools and a
// hand-edited archive is an expected path.

test('a line that is not JSON names its line number and says what to do', () => {
  const r = run([ROW, 'id,source,account', ROW]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /stdin line 2 is not JSON/);
  assert.match(r.stderr, /--format jsonl/);
});

test('a missing required field names the line and the field', () => {
  const { amount, ...noAmount } = ROW;
  const r = run([ROW, noAmount]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /stdin line 2: "amount" is missing or empty/);
});

test('an empty id is refused — it can never be in the dedupe set', () => {
  const r = run([{ ...ROW, id: '' }]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /stdin line 1: "id" is missing or empty/);
});

test('a thousands-separated amount is refused, and the VALUE stays off stderr', () => {
  // `1,234.56` reached toMinorUnits as NaN and was written as `amount: null` while the run
  // reported success. The value is transaction data and run.sh pipes stderr into a webhook, so
  // stderr names the line and stdout carries the number.
  const r = run([{ ...ROW, amount: '1,234.56' }]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /stdin line 1: amount is not a plain decimal string/);
  assert.ok(!r.stderr.includes('1,234.56'), 'an amount must not reach the alert body');
  assert.match(r.stdout, /1,234\.56/);
});

test('an unparseable date is refused, and the value stays off stderr', () => {
  const r = run([{ ...ROW, date: '28 Jul 2026 lunchtime' }]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /stdin line 1: date is not a valid timestamp/);
  assert.ok(!r.stderr.includes('lunchtime'));
  assert.match(r.stdout, /lunchtime/);
});

test('empty stdin is success, not failure — most hours have no transactions', () => {
  const r = run([]);
  assert.equal(r.status, 0);
});

// --- the mapping ------------------------------------------------------------------------

test('a missing mapping key is counted on stderr and named only on stdout', () => {
  // The keys are a card's last four digits and the user's own pot name, straight out of the
  // alert email, and run.sh ships this stderr into a Discord webhook body. This is the ordinary
  // first-week failure — a new pot, an unmapped account — so it is the leak that would happen.
  const r = run([
    { ...ROW, id: 'r1', account: '0000' },
    { ...ROW, id: 'r2', type: 'pot_transfer', payee: 'Holiday Pot' },
  ], { ACTUAL_MAIL_MAPPING: MAPPING_EMPTY });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing 2 key\(s\)/);
  assert.ok(!r.stderr.includes('0000'), 'account digits must not reach the alert body');
  assert.ok(!r.stderr.includes('Holiday Pot'), 'a pot name must not reach the alert body');
  assert.match(r.stdout, /0000/);
  assert.match(r.stdout, /pot:Holiday Pot/);
});

test('an inert no-inbound-alert licence warns, names its key only on stdout, and still imports', () => {
  // Adding `no-inbound-alert:<key>` without `<key>` itself leaves the licence unreachable, so
  // transfers into that account quietly stop being detected while every run reports healthy.
  // It warns rather than refusing: an inert licence loses a link, not money, and stopping the
  // run would cost real imports. Same leak rule as the missing-key check above — the key is
  // account digits, so it goes to stdout only.
  const r = run([{ ...ROW, account: 'card' }], {
    ACTUAL_MAIL_MAPPING: MAPPING_ORPHAN_LICENCE,
    ACTUAL_MAIL_RECONCILED_THROUGH: '2020-01-01',
  }, { stub: true });
  assert.equal(r.status, 0, r.stderr);
  // stderr only. "1 inert" is the stdout wording, so an alternation over the two used to pass on
  // a branch that could never match and would have survived the stderr line being deleted.
  assert.match(r.stderr, /not a four-digit key in the mapping/);
  assert.ok(!r.stderr.includes('0000'), 'account digits must not reach the alert body');
  assert.match(r.stdout, /no-inbound-alert:0000/);
  assert.match(r.stderr, /1 row\(s\)/, 'the run still imports');
});

test('a no-inbound-alert licence over a named key is inert too, and warns', () => {
  // The case a presence test cannot catch: `main` is mapped, so the key is there, but a payee
  // names an account by four digits and never by a name — the licence can never be reached.
  const r = run([{ ...ROW, account: 'card' }], {
    ACTUAL_MAIL_MAPPING: MAPPING_NAMED_LICENCE,
    ACTUAL_MAIL_RECONCILED_THROUGH: '2020-01-01',
  }, { stub: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /not a four-digit key in the mapping/);
  assert.match(r.stdout, /no-inbound-alert:main/);
});

test('a complete mapping says nothing about licences', () => {
  const r = run([ROW], { ACTUAL_MAIL_RECONCILED_THROUGH: '2020-01-01' }, { stub: true });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/inert/.test(r.stderr), 'no warning when there is nothing to warn about');
});

test('a mapping path that does not exist says so, rather than throwing ENOENT', () => {
  const r = run([ROW], { ACTUAL_MAIL_MAPPING: join(TMP, 'nope.json') });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /which does not exist/);
});

// --- credentials ------------------------------------------------------------------------

test('a dry run needs the same credentials as a real one — it reads the live budget', () => {
  // The Quickstart sends every newcomer down the dry-run path first, with a .env freshly copied
  // from .env.example. Exempt from this check, it died inside the Actual library with
  // `Could not get remote files`.
  const r = run([ROW], { ACTUAL_SERVER_URL: '' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ACTUAL_SERVER_URL is not set/);
});

// --- FX_MARKUP bounds -------------------------------------------------------------------
//
// The README documents 0.003 and glosses it as 0.3%, which is the phrasing that gets typed back
// as `0.3` — inflating every foreign transaction by 30% with nothing to fail.

const REJECTED = /FX_MARKUP must be a fraction/;

test('FX_MARKUP=0.3 is refused — the percentage typo', () => {
  const r = run([ROW], { FX_MARKUP: '0.3' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, REJECTED);
});

test('FX_MARKUP="0.3%" is refused rather than becoming NaN', () => {
  // NaN propagated to `amount: null`, a row Actual accepts.
  const r = run([ROW], { FX_MARKUP: '0.3%' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, REJECTED);
});

test('a negative FX_MARKUP is refused', () => {
  const r = run([ROW], { FX_MARKUP: '-0.001' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, REJECTED);
});

test('0.1 is the boundary and is accepted; just over it is not', () => {
  const over = run([ROW], { FX_MARKUP: '0.100001' });
  assert.equal(over.status, 1);
  assert.match(over.stderr, REJECTED);

  const at = run([ROW], { FX_MARKUP: '0.1' }, { stub: true });
  assert.equal(at.status, 0, at.stderr);
  assert.doesNotMatch(at.stderr, REJECTED);
});

test('0 is accepted — a budget whose bank charges no spread is legitimate', () => {
  const r = run([ROW], { FX_MARKUP: '0' }, { stub: true });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, REJECTED);
});

// --- the reconciliation floor -----------------------------------------------------------

const sgToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const sgDayOffset = (days) => new Date(Date.now() + (8 + days * 24) * 3600 * 1000)
  .toISOString().slice(0, 10);

test('a floor in the future is refused — it would skip every row and report success', () => {
  const r = run([ROW], { ACTUAL_MAIL_DRY_RUN: '', ACTUAL_MAIL_RECONCILED_THROUGH: '2126-01-01' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ACTUAL_MAIL_RECONCILED_THROUGH/);
});

test('a floor set to TODAY is refused — the rest of today would be lost permanently', () => {
  // The floor is inclusive, so today's remaining rows are skipped now and skipped again
  // tomorrow, because the floor never moves backwards. config.env.example's "Bump it when you
  // reconcile" is the instruction that produces exactly this.
  const r = run([ROW], { ACTUAL_MAIL_DRY_RUN: '', ACTUAL_MAIL_RECONCILED_THROUGH: sgToday() });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /which is today/);
});

test('a floor set to yesterday is accepted', () => {
  const r = run([ROW], { ACTUAL_MAIL_DRY_RUN: '', ACTUAL_MAIL_RECONCILED_THROUGH: sgDayOffset(-1) },
    { stub: true });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /RECONCILED_THROUGH/);
});

test('a real import with no floor at all is refused', () => {
  const r = run([ROW], { ACTUAL_MAIL_DRY_RUN: '' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ACTUAL_MAIL_RECONCILED_THROUGH is not set/);
});

// --- the sync that earns the success line ------------------------------------------------

test('a failed sync fails the run instead of reporting an import that is not on the server', () => {
  // api.shutdown() syncs inside its own `catch {}`, so a down server, an expired password or a
  // rejected sync used to give a success message, exit 0 and a healthy heartbeat over an empty
  // budget — and the next run's dedupe read the LOCAL cache, found the rows and called them
  // already present, making the "all good" signal permanent.
  const r = run([ROW], {
    ACTUAL_MAIL_DRY_RUN: '',
    ACTUAL_MAIL_RECONCILED_THROUGH: '2020-01-01',
    STUB_SYNC_FAIL: '1',
  }, { stub: true });
  assert.notEqual(r.status, 0, 'a rejected sync must not exit 0');
  assert.doesNotMatch(r.stderr, /^imported \d+ row/m, 'and must not claim the import happened');
  assert.match(r.stderr, /stub: sync rejected/);
});

test('a real import that syncs cleanly reports its counts and exits 0', () => {
  const r = run([ROW], {
    ACTUAL_MAIL_DRY_RUN: '',
    ACTUAL_MAIL_RECONCILED_THROUGH: '2020-01-01',
  }, { stub: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /imported 1 row/);
});

// --- the example mapping ------------------------------------------------------------------

test('mapping.example.json shows all six key shapes the README describes', () => {
  // The four-digit account key is the least guessable of them and a hard error on a user's first
  // PayNow transfer, and it was the one the example left out. The count is asserted too: without
  // it, deleting a line from the example failed nothing, which is how a shape goes missing again.
  const keys = Object.keys(JSON.parse(readFileSync(new URL('../mapping.example.json', import.meta.url))));
  assert.equal(keys.length, 7, 'six shapes, and the named shape appears twice');
  assert.ok(keys.includes('card'), 'a card key');
  assert.ok(keys.includes('main'), 'a main-account key');
  assert.ok(keys.some((k) => /^\d{4}$/.test(k)), 'a four-digit account key');
  assert.ok(keys.some((k) => k.startsWith('pot:')), 'a pot key');
  assert.ok(keys.some((k) => k.startsWith('wise-')), 'a Wise balance key');
  // The licence key, and it has to be four-digit: the loader now warns about any other shape,
  // because a payee names an account by digits and never by a name.
  assert.ok(keys.some((k) => /^no-inbound-alert:\d{4}$/.test(k)), 'a no-inbound-alert licence key');
  // The untracked key carries null, not an id, and the example is the only place that shape is
  // written down. A UUID here would read as "point it at an account", which is the thing it
  // exists to avoid.
  const untracked = keys.filter((k) => k.startsWith('untracked:'));
  assert.equal(untracked.length, 1, 'an untracked source-account key');
  const example = JSON.parse(readFileSync(new URL('../mapping.example.json', import.meta.url)));
  assert.equal(example[untracked[0]], null, 'an untracked key names no account');
});

// --- untracked source accounts ----------------------------------------------------------
//
// Wise holds a balance per currency; the budget carries one SGD Wise account. A wise-aud row
// mapped into it was FX-converted and booked as an SGD debit that never happened. The licence
// has to survive the mapping-completeness gate, which runs before loadRows ever sees the row.

const AUD_ROW = { ...ROW, id: 'aud-1', source: 'wise', account: 'wise-aud',
                  amount: '-42.00', currency: 'AUD', payee: 'TEST MERCHANT AU' };

test('an untracked account is not reported as a missing mapping key', () => {
  const r = run([ROW, AUD_ROW],
    { ACTUAL_MAIL_MAPPING: MAPPING_UNTRACKED }, { stub: true });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/missing \d+ key/.test(r.stderr), 'a deliberately untracked account is not missing');
});

test('the run reports how many rows were set aside as untracked', () => {
  const r = run([ROW, AUD_ROW],
    { ACTUAL_MAIL_MAPPING: MAPPING_UNTRACKED }, { stub: true });
  assert.equal(r.status, 0, r.stderr);
  // The summary line is stderr, which is what run.sh ships into the Discord webhook body. A
  // count carries no account key, so it is safe there where the key itself would not be.
  assert.match(r.stderr, /1 untracked/);
  // The whole point: it is set aside, not converted. An FX-estimated count here would mean the
  // AUD row went through the rate path into the SGD account, which is the defect.
  assert.ok(!/FX-estimated/.test(r.stderr), 'an untracked row must not be FX-estimated');
  // And the row itself never reaches a budget line.
  assert.ok(!r.stdout.includes('aud-1'), 'an untracked row must not be written');
  assert.equal(r.stdout.match(/^DRY /gm).length, 1);
});

test('a mapping key with an unrecognised prefix is refused, not quietly ignored', () => {
  // The failure this prevents is not a missing import — it is an invented one. `untraked:` is
  // not a licence, so the ordinary key still resolves and the AUD row is FX-converted into the
  // SGD account. Refusing beats warning here: a warning still writes the money.
  const r = run([ROW], { ACTUAL_MAIL_MAPPING: MAPPING_TYPO_PREFIX }, { stub: true });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unrecognised prefix/);
  // Same channel split as every other mapping complaint: the shape on stderr, which run.sh
  // ships to Discord, and the key itself on stdout, which stays on the host.
  assert.ok(!r.stderr.includes('untraked:wise-aud'), 'a mapping key must not reach the alert body');
  assert.match(r.stdout, /untraked:wise-aud/);
});

test('an untracked key carrying an account id is refused', () => {
  const r = run([ROW], { ACTUAL_MAIL_MAPPING: MAPPING_UNTRACKED_VALUE }, { stub: true });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /must be null/);
});

test('the untracked keys in force are named on stdout, so a quiet day is not mistaken for an unconfigured one', () => {
  // Without this, "the mechanism is on and nothing matched" and "nobody ever added the key"
  // produce byte-identical output, which is how the fix ships switched off and nobody notices.
  const r = run([ROW], { ACTUAL_MAIL_MAPPING: MAPPING_UNTRACKED }, { stub: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /untracked source account\(s\) in force/);
  assert.match(r.stdout, /wise-aud/);
});

test('an untracked licence over a pot target is refused rather than silently doing nothing', () => {
  const r = run([ROW], { ACTUAL_MAIL_MAPPING: MAPPING_UNTRACKED_POT }, { stub: true });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /pot target cannot be untracked/);
});

test('an untracked account that is still mapped is refused, because it can still be written to', () => {
  // Not a tidiness rule. While the ordinary key resolves, the account remains a legal target for
  // a transfer leg invented from a payee, so money is written INTO an account the operator has
  // declared outside the budget. Refusing the coexistence is what makes "untracked" mean
  // unresolvable, which closes pairing, licence targeting and the direct write in one place
  // rather than three.
  const r = run([ROW], { ACTUAL_MAIL_MAPPING: MAPPING_UNTRACKED_COEXIST }, { stub: true });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /also mapped/);
  assert.ok(!r.stderr.includes('untracked:0000'), 'a mapping key must not reach the alert body');
  assert.match(r.stdout, /untracked:0000/);
});

test('every mapping problem in one run, not one per run cycle', () => {
  // The file promises this 40 lines above the missing-key check, and three sequential exits
  // broke it: an operator with two mistakes fixed one, waited an hour, and found the next.
  const both = join(TMP, 'mapping-two-faults.json');
  writeFileSync(both, JSON.stringify({
    '0000': '00000000-0000-0000-0000-00000000000a',
    'untraked:wise-aud': null,
    'untracked:wise-usd': '00000000-0000-0000-0000-00000000000c',
  }));
  const r = run([ROW], { ACTUAL_MAIL_MAPPING: both }, { stub: true });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unrecognised prefix/);
  assert.match(r.stderr, /must be null/);
});

test('the in-force listing says how many rows each untracked key matched', () => {
  // A typo in the KEY half passes every refusal — it is a legal prefix, a null value and no
  // colon — and then matches nothing while the ordinary key still imports the rows. A count of
  // zero beside the key is what makes that visible without a per-run warning nobody would read.
  const m = join(TMP, 'mapping-untracked-counts.json');
  writeFileSync(m, JSON.stringify({
    '0000': '00000000-0000-0000-0000-00000000000a',
    'untracked:wise-aud': null,
    'untracked:wise-uad': null,
  }));
  const aud = { ...ROW, id: 'aud-2', source: 'wise', account: 'wise-aud',
                amount: '-42.00', currency: 'AUD', payee: 'TEST MERCHANT AU' };
  const r = run([ROW, aud], { ACTUAL_MAIL_MAPPING: m }, { stub: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /wise-aud \(1 row/);
  assert.match(r.stdout, /wise-uad \(0 rows/);
});

// --- relinking a pair whose counterpart is already in the budget --------------------------

const RELINK_ROWS = [
  { ...ROW, id: 'r-out', account: '0000', amount: '-700.00', payee: 'somebody',
    type: 'transfer_out', date: '2026-07-28T07:24:00+08:00', raw_ref: '<u>' },
  { ...ROW, id: 'r-in', account: 'card', amount: '700.00', payee: 'somebody',
    type: 'transfer_in', date: '2026-07-28T07:24:00+08:00', raw_ref: '<t>' },
];
// The `card` leg is already a plain transaction in the budget, as it would be after arriving in
// an earlier run than its partner.
const RELINK_EXISTING = JSON.stringify({
  '00000000-0000-0000-0000-00000000000b': [
    { id: 'existing-1', imported_id: 'r-in', amount: 70000, date: '2026-07-28' },
  ],
});

test('a dry run reports the relink and deletes NOTHING', () => {
  // The whole point of a rehearsal. A dry run that deletes a real transaction would be the worst
  // possible version of the ACTUAL_MAIL_DRY_RUN bug this repo already fixed once.
  const deletes = join(TMP, 'deletes-dry.log');
  writeFileSync(deletes, '');
  const r = run(RELINK_ROWS, {
    STUB_EXISTING: RELINK_EXISTING, STUB_DELETES: deletes,
    ACTUAL_MAIL_RECONCILED_THROUGH: '2026-07-01',
  }, { stub: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(deletes, 'utf8'), '', 'a dry run must not delete a transaction');
  assert.match(r.stdout, /WOULD DELETE/);
  // And NOT the past tense on the same run whose last line says "nothing written". Asserting the
  // presence of one wording says nothing about the absence of the contradictory one.
  assert.doesNotMatch(r.stdout, /^DELETED/m);
});

test('a real run deletes the stale leg and counts the relink', () => {
  const deletes = join(TMP, 'deletes-real.log');
  writeFileSync(deletes, '');
  const r = run(RELINK_ROWS, {
    STUB_EXISTING: RELINK_EXISTING, STUB_DELETES: deletes,
    ACTUAL_MAIL_RECONCILED_THROUGH: '2026-07-01', ACTUAL_MAIL_DRY_RUN: '0',
  }, { stub: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(deletes, 'utf8').trim(), 'existing-1');
  assert.match(r.stderr, /1 transfer\(s\) relinked/);
});

test('a dry run does not clear a mirror either', () => {
  // Same principle as the delete: a rehearsal writes nothing at all, including a flag.
  const updates = join(TMP, 'updates-dry.log');
  writeFileSync(updates, '');
  const r = run(RELINK_ROWS, {
    STUB_EXISTING: RELINK_EXISTING, STUB_UPDATES: updates,
    ACTUAL_MAIL_RECONCILED_THROUGH: '2026-07-01',
  }, { stub: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(updates, 'utf8'), '', 'a dry run must not update a transaction');
});
