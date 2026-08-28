#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as api from '@actual-app/api';
import { loadRows, sgDay, inScope, fxDatesFor, splitUntracked, NO_INBOUND_ALERT, UNTRACKED } from '../src/load/load.js';
import { fetchRates, makeRateLookup, DEFAULT_MARKUP } from '../src/load/fx.js';

const USAGE = `actual-mail-load - normalised transaction rows on stdin -> Actual Budget

Usage: actual-mail --format jsonl | actual-mail-load

Reads one JSON object per line on stdin. Every setting comes from the environment:

  ACTUAL_SERVER_URL, ACTUAL_PASSWORD          your Actual server and its login
  ACTUAL_SYNC_ID, ACTUAL_BUDGET_PASSWORD      the budget file and its encryption password
  ACTUAL_MAIL_MAPPING                         path to mapping.json
  ACTUAL_MAIL_RECONCILED_THROUGH  YYYY-MM-DD  rows on or before this are skipped (required)
  ACTUAL_MAIL_DRY_RUN=1                       report what would be written, write nothing
  BASE_CURRENCY, FX_MARKUP                    see the README

Exit 0 on success or on empty stdin, 1 on any refusal.
`;
// Ahead of the stdin read, or `--help` blocks on a terminal forever having printed nothing. CI's
// claim that "--help exits 0 on both entrypoints" held for this one only because `docker run`
// without -i hands it an empty stdin, so the step proved the COPY layout rather than the flag.
if (process.argv.includes('--help')) { process.stdout.write(USAGE); process.exit(0); }

// Anything derived from a row's own contents prints HERE, never to stderr. run.sh pipes this
// process's stderr straight into a Discord webhook body, so a last-four, a pot name, a payee or
// an amount written there leaves the host on the most ordinary failure this tool has — a new pot
// or an unmapped account in your first week. The extract half already follows this rule and says
// why (src/cli.js: "The Message-ID, never the subject"); the load half did not. stdout stays on
// the machine, so stderr gets counts and kinds and stdout gets the values.
//
// writeFileSync on fd 1, not console.log: stdout to a pipe is asynchronous and process.exit()
// truncates whatever has not flushed — which would silently drop exactly the line the operator
// needs to fix the run.
const local = (line) => writeFileSync(1, `${line}\n`);

// stdin is a trust boundary, not an internal call. The README invites these rows through other
// tools, and a hand-edited archive is an expected path — so this validates rather than assuming
// makeRow() was ever involved. Three failures were reachable without it: a bare JSON SyntaxError
// naming no line (piping the CSV from Quickstart step 3 into step 5 does exactly this), an
// amount like "1,234.56" reaching toMinorUnits() as NaN and being written as `amount: null`
// while the run reported success, and an empty id that can never be in the dedupe set and so
// re-imports on every run forever.
const AMOUNT = /^-?\d+\.\d{2}$/;
const rows = readFileSync(0, 'utf8').trim().split('\n').filter(Boolean).map((line, i) => {
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    console.error(`stdin line ${i + 1} is not JSON. Expected one JSON object per line — `
      + 'if this is CSV, re-run the extract with `--format jsonl`.');
    process.exit(1);
  }
  for (const field of ['id', 'account', 'date', 'amount', 'currency']) {
    if (!row[field]) { console.error(`stdin line ${i + 1}: "${field}" is missing or empty`); process.exit(1); }
  }
  if (!AMOUNT.test(row.amount)) {
    console.error(`stdin line ${i + 1}: amount is not a plain decimal string `
      + '(no thousands separators, exactly two decimal places). The value is on stdout.');
    local(`stdin line ${i + 1}: amount "${row.amount}"`);
    process.exit(1);
  }
  if (Number.isNaN(new Date(row.date).getTime())) {
    console.error(`stdin line ${i + 1}: date is not a valid timestamp. The value is on stdout.`);
    local(`stdin line ${i + 1}: date "${row.date}"`);
    process.exit(1);
  }
  return row;
});

if (rows.length === 0) {
  console.error('no rows on stdin, nothing to do');
  process.exit(0);
}

const mappingPath = process.env.ACTUAL_MAIL_MAPPING;
if (!mappingPath) { console.error('ACTUAL_MAIL_MAPPING is not set'); process.exit(1); }
// Named, not a raw ENOENT or SyntaxError from node's internals. Three lines below this the
// missing-key error is exemplary ("mapping.json is missing 2 key(s):" then each key), so a bare
// stack trace here is an inconsistency a first-time user meets before anything else.
let mapping;
try {
  mapping = JSON.parse(readFileSync(mappingPath, 'utf8'));
} catch (e) {
  console.error(e.code === 'ENOENT'
    ? `ACTUAL_MAIL_MAPPING points at ${mappingPath}, which does not exist. Copy mapping.example.json and fill in your account ids.`
    : `${mappingPath} is not valid JSON: ${e.message}`);
  process.exit(1);
}

// The three credentials api.init() and downloadBudget() need. Unset, they used to reach the Actual
// client as `undefined` and fail somewhere inside it, which reads as a server or sync problem
// rather than as a missing setting.
//
// A dry run is NOT exempt, and used to be. It downloads the live budget — that is the feature's
// premise, its already-present count is real precisely because it reads the real accounts — so it
// needs the same three settings. Exempting it sent the Quickstart's first command, run with a
// freshly copied .env, into an uncaught `Error: Could not get remote files` from inside the Actual
// library: the exact failure this check exists to replace, on the one path every newcomer takes.
for (const key of ['ACTUAL_SERVER_URL', 'ACTUAL_PASSWORD', 'ACTUAL_SYNC_ID']) {
  if (!process.env[key]) {
    console.error(`${key} is not set. See the Configuration section of the README.`);
    process.exit(1);
  }
}

const dryRun = process.env.ACTUAL_MAIL_DRY_RUN === '1';

// Reconciliation is a human action and reconciled history is settled, so the floor is
// mandatory for a real import — the failure mode it prevents is backfilling a balanced
// account, which is silent and tedious to undo.
const reconciledThrough = process.env.ACTUAL_MAIL_RECONCILED_THROUGH ?? null;
if (!dryRun && !reconciledThrough) {
  console.error('ACTUAL_MAIL_RECONCILED_THROUGH is not set (YYYY-MM-DD, the last date you '
    + 'reconciled). Rows on or before it are skipped so a real import never backfills.');
  process.exit(1);
}
if (reconciledThrough && !/^\d{4}-\d{2}-\d{2}$/.test(reconciledThrough)) {
  console.error(`ACTUAL_MAIL_RECONCILED_THROUGH must be YYYY-MM-DD, got "${reconciledThrough}"`);
  process.exit(1);
}
// A floor in the future skips EVERY row and reports success. The shape check above passes a
// fat-fingered year, loadRows counts the rows into `skipped`, and nothing surfaces that — so the
// budget quietly stops receiving money while the log line and the heartbeat both read healthy.
// The floor is hand-edited on every reconciliation, which is exactly when a typo happens.
//
// TODAY is refused too, and that is not pedantry: the floor is inclusive, so a floor of today
// discards the rest of today — and tomorrow's run skips those same rows again, because the floor
// has not moved and never will move backwards. They are lost permanently, counted only as
// `skipped`. config.env.example says "Bump it when you reconcile", and reconciling on the day you
// bump it is exactly what produces this.
const today = sgDay(new Date().toISOString());
if (reconciledThrough && reconciledThrough >= today) {
  console.error(`ACTUAL_MAIL_RECONCILED_THROUGH is "${reconciledThrough}", which is today `
    + `(${today}) or later. The floor is inclusive, so every row from that date on would be `
    + 'skipped as already reconciled — today\'s remaining rows permanently, since tomorrow\'s '
    + 'run skips them again. Set it to the last date you reconciled, which is yesterday at the '
    + 'newest.');
  process.exit(1);
}

// A licence with no account behind it. `no-inbound-alert:<key>` only does anything when `<key>`
// is itself mapped: pairing resolves a payee-named account through the ordinary key first, so an
// orphan licence is INERT — transfers into that account quietly go back to being ordinary spends
// and the operator sees a healthy run that has simply stopped detecting them. Silent failure in a
// money path is the class of bug this tool exists to prevent, and nothing else reports it: the
// `needed` set below is built from row-derived keys and never walks the mapping.
//
// A warning, not a refusal. An inert licence loses a LINK, never money — both legs still import
// as ordinary transactions, and the far leg is one that was never going to be invented anyway.
// Exiting would stop a whole run of otherwise correct imports over a typo in an optional entry,
// which trades a real loss for a cosmetic one. It also runs before the completeness refusal
// below so one run reports every mapping problem at once, the same promise that check makes.
//
// The key's SHAPE is checked as well as its presence. `namedAccount` in src/load/transfers.js
// matches `a/c ending <four digits>` and can only ever hand back a four-digit group, so a licence
// over any other key — `no-inbound-alert:main`, say — is just as inert however well `main` itself
// is mapped, and a presence test alone waves it through. The truthiness test is left as it is on
// purpose: it mirrors `namedAccount`'s own `mapping[m[1]]` lookup, and making those two disagree
// is how this check starts reporting a problem the loader does not have.
const orphanLicences = Object.keys(mapping).filter((k) => {
  if (!k.startsWith(NO_INBOUND_ALERT)) return false;
  const key = k.slice(NO_INBOUND_ALERT.length);
  return !/^\d{4}$/.test(key) || !mapping[key];
});
if (orphanLicences.length) {
  // Same split as the missing-key check below: the shape of the problem on stderr, the keys
  // themselves on stdout, because a key here is an account's last four digits.
  console.error(`mapping.json has ${orphanLicences.length} "${NO_INBOUND_ALERT}" entry(ies) whose `
    + 'account key is not a four-digit key in the mapping. Each is inert, so transfers into that '
    + 'account are NOT being detected. The keys themselves are on stdout, on this host — they are account '
    + 'digits, so they are not put in this message.');
  local(`mapping.json has ${orphanLicences.length} inert ${NO_INBOUND_ALERT} entry(ies):`);
  for (const k of orphanLicences) local(`  ${k}`);
}

// Every legal prefixed key shape, and the list is closed. A key like `untraked:wise-aud` is not
// a licence, so the ordinary `wise-aud` key beside it still resolves and the row is FX-converted
// into an account it does not belong in — money invented, run reports success. There is no fuzzy
// match for a typo, but there does not need to be: three prefixes are legal and anything else is
// a mistake. Refusing beats warning, because a warning still writes the money. Checked against
// the constants the loader itself honours, so this cannot drift from them.
const PREFIXES = ['pot:', NO_INBOUND_ALERT, UNTRACKED];
const badPrefix = Object.keys(mapping)
  .filter((k) => k.includes(':') && !PREFIXES.some((p) => k.startsWith(p)));
if (badPrefix.length) {
  console.error(`mapping.json has ${badPrefix.length} key(s) with an unrecognised prefix. Legal `
    + `prefixes are ${PREFIXES.join(' ')}. Each is inert, and an inert ${UNTRACKED} licence means `
    + 'the row it should have set aside is imported instead. The keys themselves are on stdout, on '
    + 'this host — they can carry account digits, so they are not put in this message.');
  local(`mapping.json has ${badPrefix.length} key(s) with an unrecognised prefix:`);
  for (const k of badPrefix) local(`  ${k}`);
  process.exit(1);
}

// An `untracked:` key names no account, so its value must be null. A stray id there is not
// merely untidy: `Object.values(mapping)` drives the dedupe read, and a non-null value makes the
// loader ask Actual for the transactions of an account that need not exist.
// A pot target cannot be untracked: splitUntracked matches a row's SOURCE account, so the key
// can never fire, and a pot move is two-sided anyway — excluding one side of it is already a
// contradiction. Grouped with the value check because both are the same mistake, a key that
// looks live in the file and does nothing.
const untrackedPots = Object.keys(mapping)
  .filter((k) => k.startsWith(UNTRACKED) && k.slice(UNTRACKED.length).includes(':'));
if (untrackedPots.length) {
  console.error(`mapping.json has ${untrackedPots.length} "${UNTRACKED}" key(s) over a prefixed `
    + 'key. A pot target cannot be untracked — the licence matches the row source account, so '
    + 'the key never fires. The keys are on stdout, on this host.');
  local(`mapping.json has ${untrackedPots.length} ${UNTRACKED} key(s) over a pot target:`);
  for (const k of untrackedPots) local(`  ${k}`);
  process.exit(1);
}

const untrackedWithValue = Object.keys(mapping)
  .filter((k) => k.startsWith(UNTRACKED) && mapping[k] !== null);
if (untrackedWithValue.length) {
  console.error(`mapping.json has ${untrackedWithValue.length} "${UNTRACKED}" key(s) whose value `
    + 'must be null — the account is outside the budget, so there is no id to name. The keys are '
    + 'on stdout, on this host.');
  local(`mapping.json has ${untrackedWithValue.length} ${UNTRACKED} key(s) that must be null:`);
  for (const k of untrackedWithValue) local(`  ${k}`);
  process.exit(1);
}

// Positive confirmation that the mechanism is configured. Without it "on, and nothing matched
// today" and "nobody ever added the key" are byte-identical, which is how a fix ships switched
// off and stays that way. Names go to stdout with every other mapping key, never to the alert.
const untrackedKeys = Object.keys(mapping).filter((k) => k.startsWith(UNTRACKED));
if (untrackedKeys.length) {
  local(`${untrackedKeys.length} untracked source account(s) in force:`);
  for (const k of untrackedKeys) local(`  ${k.slice(UNTRACKED.length)}`);
}

// Completeness check on the mapping, over the rows that will actually be written. Reporting
// every missing key at once beats discovering them one hard error at a time. inScope() lives in
// load.js so it cannot disagree with loadRows about which rows are in scope.
// splitUntracked first, so an account the operator deliberately kept out of the budget is not
// reported as a missing key and does not put its date on the FX list. Both checks below ask
// "what will actually be written", and an untracked row will not be — loadRows partitions the
// same way, from the same mapping, so the two cannot disagree about which rows those are.
const willImport = inScope(splitUntracked(rows, mapping).tracked, reconciledThrough);
// A pot transfer needs BOTH keys — the account it leaves and the pot it lands in — and
// loadRows throws on either. Substituting one for the other meant pot rows fell out of the
// "report every missing key at once" promise and failed one hard error at a time instead.
const needed = new Set(willImport.flatMap((r) => (
  r.type === 'pot_transfer' ? [r.account, `pot:${r.payee}`] : [r.account])));
const missing = [...needed].filter((k) => !mapping[k]);
if (missing.length) {
  // The keys ARE the data: an account key is the last four digits out of the alert email and a
  // pot key is the user's own pot name. They go to stdout (see `local` above), stderr gets the
  // shape of the problem. This failure is the ordinary first-week one — a new pot, an account
  // not yet mapped — so it is the leak that would actually happen.
  const pots = missing.filter((k) => k.startsWith('pot:')).length;
  console.error(`mapping.json is missing ${missing.length} key(s): ${missing.length - pots} `
    + `account(s), ${pots} pot(s). The keys themselves are on stdout, on this host — they are `
    + 'account digits and pot names, so they are not put in this message.');
  local(`mapping.json is missing ${missing.length} key(s):`);
  for (const k of missing) local(`  ${k}`);
  process.exit(1);
}

// Fetch a rate for every date carrying a row that is not in the base currency. If this throws,
// nothing is written — a foreign row is never imported without a rate. fxDatesFor() lives beside
// loadRows for the same reason inScope() does; the UTC-vs-Singapore-day disagreement it fixes is
// documented there. willImport, not rows, so a run whose only foreign rows are already reconciled
// does not need the rate service up at all.
const fxDates = fxDatesFor(willImport);
// A fraction, not a percentage, and bounded. The README documents 0.003 and glosses it as 0.3%,
// which is the phrasing that gets typed back as `0.3` — silently inflating every foreign
// transaction by 30% with nothing to fail. `0.3%` is worse: Number() gives NaN, which propagates
// to `amount: null` and a row Actual accepts.
const markup = process.env.FX_MARKUP ? Number(process.env.FX_MARKUP) : DEFAULT_MARKUP;
if (!Number.isFinite(markup) || markup < 0 || markup > 0.1) {
  console.error(`FX_MARKUP must be a fraction between 0 and 0.1 (0.003 is 0.3%), got `
    + `"${process.env.FX_MARKUP}"`);
  process.exit(1);
}
const rateMap = fxDates.length ? await fetchRates(fxDates) : new Map();
const rateLookup = makeRateLookup(rateMap, markup);

// Package-relative, not cwd-relative: this is normally run from the repo root, and Actual
// scandirs the cache before creating it.
const dataDir = process.env.ACTUAL_DATA_DIR
  ?? fileURLToPath(new URL('../.actual-cache', import.meta.url));
mkdirSync(dataDir, { recursive: true });

await api.init({
  dataDir,
  serverURL: process.env.ACTUAL_SERVER_URL,
  password: process.env.ACTUAL_PASSWORD,          // server login
});

try {
  // Two passwords: the budget file is end-to-end encrypted, so downloadBudget needs the
  // file's own encryption password. Supplying only the server password authenticates fine
  // and then fails here — a failure that reads like a sync problem, not a missing secret.
  await api.downloadBudget(process.env.ACTUAL_SYNC_ID, {
    password: process.env.ACTUAL_BUDGET_PASSWORD,
  });

  // Actual links both sides of a transfer when the payee is the target account's transfer
  // payee, so pot moves need that lookup.
  const payees = await api.getPayees();
  const xferByAccount = new Map(payees.filter((p) => p.transfer_acct).map((p) => [p.transfer_acct, p.id]));
  const transferPayeeFor = (accountId) => {
    const id = xferByAccount.get(accountId);
    if (!id) throw new Error(`account ${accountId} has no transfer payee — is the id right?`);
    return id;
  };

  // The dry run goes through the same loadRows against the same live account, so its
  // already-present count is real; only the write is stubbed.
  // On stdout, not stderr: every one of these lines is an amount and a payee. Under run.sh a
  // dry run's stderr would be the body of a webhook alert.
  const sink = { getTransactions: api.getTransactions, addTransactions: async (accountId, txns) => {
    for (const t of txns) {
      local(`DRY ${t.date} ${String(t.amount).padStart(9)}  ${accountId}  `
        + `${t.payee ? `[transfer ${t.payee}]` : t.payee_name}`);
    }
  } };

  // Every transfer names an amount and two accounts, so it goes to stdout. stderr becomes a
  // Discord webhook body under run.sh — see the note at the top of this file.
  const onTransfer = ({ date, amount, from, to }) =>
    local(`TRANSFER ${date} ${String(amount).padStart(9)}  ${from} -> ${to}`);

  const { imported, converted, skipped, alreadyPresent, untracked,
          transfers, transfersAlreadySeparate, ambiguous } = await loadRows(
    rows, mapping, dryRun ? sink : api, rateLookup,
    { reconciledThrough, transferPayeeFor, onTransfer });

  const tail = `${converted ? `, ${converted} FX-estimated` : ''}`
    + `${skipped ? `, ${skipped} skipped as reconciled` : ''}`
    // Set aside because their source account is outside the budget, NOT converted into it.
    // Counted rather than merely absent: a row that vanishes with nothing said is the quiet
    // loss this loader exists to prevent, and the count is what makes a mis-typed
    // `untracked:` key visible as rows going missing instead of as silence.
    + `${untracked ? `, ${untracked} untracked` : ''}`
    + `${alreadyPresent ? `, ${alreadyPresent} already present` : ''}`
    + `${transfers ? `, ${transfers} transfer(s)` : ''}`
    // At least one leg was already in the budget — an ordinary transaction, a transfer leg
    // written under an older mapping, or a row in another account — so the pair was refused
    // rather than linked — linking would mean editing a transaction already there. The
    // other leg, if it was new, IS written and counted in `imported`. Not "already imported
    // separately": that wording says both legs are present, which was the reading that hid a
    // dropped leg for a whole release.
    + `${transfersAlreadySeparate ? `, ${transfersAlreadySeparate} transfer(s) left unlinked` : ''}`
    // Same amount, same window, more than one candidate. Left as ordinary transactions
    // rather than guessed at.
    + `${ambiguous ? `, ${ambiguous} ambiguous, left unpaired` : ''}`;
  // Sync BEFORE claiming the import happened. api.shutdown() does sync, but wrapped in its own
  // `catch {}` — so a down server, an expired password or a rejected sync gave a success message,
  // exit 0 and a healthy heartbeat over an empty budget. Worse on the next run: the dedupe reads
  // the LOCAL cache, which does hold the rows, so it reports them already present and the "all
  // good" signal becomes permanent. Here the failure is loud and the success line is earned.
  if (!dryRun && imported > 0) await api.sync();
  console.error(dryRun
    ? `dry run: ${imported} row(s) would be written${tail}, nothing written`
    : `imported ${imported} row(s)${tail}`);
} finally {
  await api.shutdown();
}
