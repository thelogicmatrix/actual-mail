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

const MAPPING = join(TMP, 'mapping.json');
writeFileSync(MAPPING, JSON.stringify({
  '0000': '00000000-0000-0000-0000-00000000000a',
  card: '00000000-0000-0000-0000-00000000000b',
}));

// A mapping deliberately missing the row's account, for the leak test below. Kept separate so
// the main MAPPING stays complete for every other test. The account placeholder is all-zeros
// throughout, per the convention in scripts/scan-pii.js: any other four-digit literal is
// indistinguishable from a real account number to the gate, and rightly trips it.
const MAPPING_EMPTY = join(TMP, 'mapping-empty.json');
writeFileSync(MAPPING_EMPTY, JSON.stringify({
  card: '00000000-0000-0000-0000-00000000000b',
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
export const getPayees = async () => [];
export const getTransactions = async () => [];
export const addTransactions = async (id, txns) => txns.map((t) => t.imported_id);
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

test('mapping.example.json shows all four key shapes the README describes', () => {
  // The four-digit account key is the least guessable of them and a hard error on a user's first
  // PayNow transfer, and it was the one the example left out.
  const keys = Object.keys(JSON.parse(readFileSync(new URL('../mapping.example.json', import.meta.url))));
  assert.ok(keys.includes('card'), 'a card key');
  assert.ok(keys.includes('main'), 'a main-account key');
  assert.ok(keys.some((k) => /^\d{4}$/.test(k)), 'a four-digit account key');
  assert.ok(keys.some((k) => k.startsWith('pot:')), 'a pot key');
  assert.ok(keys.some((k) => k.startsWith('wise-')), 'a Wise balance key');
});
