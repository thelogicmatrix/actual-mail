// Proves the loader against a real Actual budget without touching Nathan's.
//
// Creates a throwaway LOCAL budget (no serverURL, so nothing syncs anywhere), builds the
// same account shape the real mapping will use, and imports the rows on stdin twice. The
// second pass is the point: it proves imported_id dedup, which is the only thing standing
// between a re-run and a duplicated month.
//
//   node --env-file=.env bin/actual-mail.js --since ... --format jsonl --source trust-sg \
//     | node scripts/verify-scratch.js
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as api from '@actual-app/api';
import { loadRows, inScope, fxDatesFor, splitUntracked } from '../src/load/load.js';
import { pairRows } from '../src/load/transfers.js';
import { fetchRates, makeRateLookup, DEFAULT_MARKUP } from '../src/load/fx.js';

const rows = readFileSync(0, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
if (!rows.length) throw new Error('no rows on stdin');

const POTS = [...new Set(rows.filter((r) => r.type === 'pot_transfer').map((r) => r.payee))];
const RECONCILED_THROUGH = process.env.ACTUAL_MAIL_RECONCILED_THROUGH ?? null;

const dataDir = fileURLToPath(new URL('../.scratch-cache', import.meta.url));
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

// fxDatesFor and inScope come from load.js rather than being restated here, and that is the
// whole point: the restatement used `r.date.slice(0, 10)`, the UTC day, while loadRows looks a
// rate up by the Singapore day. On a row stamped 2026-08-31T17:30:00Z those differ by a day and
// a month, makeRateLookup threw `no FX rate fetched for ...`, and the tool that exists to build
// an adopter's confidence took the whole batch down instead. A previous version of this comment
// asked the reader to keep this line equal to the one in bin/; importing the function is what
// makes that unnecessary. (They also handle the base currency properly: under a non-SGD base
// every SGD row IS foreign and needs a rate.)
const willImport = inScope(rows, RECONCILED_THROUGH);
const fxDates = fxDatesFor(willImport);
const rateLookup = makeRateLookup(fxDates.length ? await fetchRates(fxDates) : new Map(), DEFAULT_MARKUP);

await api.init({ dataDir });          // local only — no serverURL, no password, no sync
try {
  await api.runImport('actual-mail-scratch', async () => {
    const trust = await api.createAccount({ name: 'Trust', offBudget: false }, 0);
    // TWO accounts, not one. Every source account used to map to `trust`, and pairRows requires
    // two DIFFERENT resolved accounts, so a transfer could never form here — which meant the
    // transfer path and, later, the delete path were categorically unreachable in the one script
    // that runs against a real Actual budget. Both rested entirely on a hand-written stub, and
    // this feature has already shipped one behaviour no stub predicted: Actual accepting a payee
    // change and silently declining to create the counterpart, which cost real money.
    //
    // The split mirrors the real mapping's shape rather than being arbitrary: Wise balances are
    // their own account, everything a bank alert names is the bank account.
    const wise = await api.createAccount({ name: 'Wise', offBudget: false }, 0);
    const accountFor = (a) => (a.startsWith('wise-') ? wise : trust);
    // Every account the rows actually name, not three hardcoded Trust keys. The README teaches
    // `--source all` everywhere, whose first Wise row carries `wise-<currency>` — unmapped, and
    // loadRows hard-throws on an unmapped account, so the documented pipe died here. Derived
    // this way it also works for any parser a contributor adds.
    const mapping = Object.fromEntries(
      [...new Set(rows.map((r) => r.account))].map((a) => [a, accountFor(a)]));
    for (const pot of POTS) {
      mapping[`pot:${pot}`] = await api.createAccount({ name: pot, offBudget: false }, 0);
    }

    const payees = await api.getPayees();
    const xfer = new Map(payees.filter((p) => p.transfer_acct).map((p) => [p.transfer_acct, p.id]));
    const transferPayeeFor = (id) => {
      const p = xfer.get(id);
      if (!p) throw new Error(`no transfer payee for account ${id}`);
      return p;
    };
    const opts = { reconciledThrough: RECONCILED_THROUGH, transferPayeeFor };

    const first = await loadRows(rows, mapping, api, rateLookup, opts);
    const second = await loadRows(rows, mapping, api, rateLookup, opts);
    console.log(`pass 1: imported ${first.imported}, skipped ${first.skipped}, fx ${first.converted}`);
    console.log(`pass 2: imported ${second.imported}, already present ${second.alreadyPresent}, `
      + `transfers ${first.transfers}`);

    const all = await api.getTransactions(trust, '2000-01-01', '2100-01-01');
    const ids = all.map((t) => t.imported_id).filter(Boolean);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);

    console.log(`Trust holds ${all.length} transaction(s), ${new Set(ids).size} distinct imported_id`);

  });

  // --- the delete path, against a real Actual budget -------------------------------------
  //
  // The only destructive thing this tool does, and until now it had unit coverage only, because
  // verify-scratch mapped every source account to ONE Actual account and a pair needs two. Its
  // OWN budget, because the passes above already hold every row and a relink needs the state
  // where exactly one leg is present.
  //
  // Driven the way it actually happens rather than by editing transactions: import one leg of a
  // pair on its own, as the earlier run would have, then import everything.
  const scoped = inScope(rows, RECONCILED_THROUGH);
  await api.runImport('actual-mail-scratch-relink', async () => {
    const trust = await api.createAccount({ name: 'Trust', offBudget: false }, 0);
    const wise = await api.createAccount({ name: 'Wise', offBudget: false }, 0);
    const mapping = Object.fromEntries([...new Set(rows.map((r) => r.account))]
      .map((a) => [a, a.startsWith('wise-') ? wise : trust]));
    for (const pot of POTS) {
      mapping[`pot:${pot}`] = await api.createAccount({ name: pot, offBudget: false }, 0);
    }
    const payees = await api.getPayees();
    const xfer = new Map(payees.filter((p) => p.transfer_acct).map((p) => [p.transfer_acct, p.id]));
    const opts = { reconciledThrough: RECONCILED_THROUGH,
      transferPayeeFor: (id) => xfer.get(id) };

    const [pair] = pairRows(splitUntracked(scoped, mapping).tracked, mapping).pairs;
    if (!pair) {
      console.log('relink: no pair in this sample, delete path not exercised');
      return;
    }
    const balances = async () => [await api.getAccountBalance(trust), await api.getAccountBalance(wise)];

    const solo = await loadRows([pair.into], mapping, api, rateLookup, opts);
    assert.equal(solo.imported, 1, 'the lone leg should import as an ordinary transaction');
    const before = await balances();

    const relinked = await loadRows(rows, mapping, api, rateLookup, opts);
    assert.equal(relinked.transfersRelinked, 1,
      'the second pass must relink the pair, not report it left unlinked');

    const outAcct = mapping[pair.out.account];
    const written = await api.getTransactions(outAcct, '2000-01-01', '2100-01-01');
    const joined = written.filter((t) => String(t.imported_id).includes('+'));
    assert.equal(joined.length, 1, 'exactly one joined transfer row');
    const intoAcct = mapping[pair.into.account];
    const intoRows = await api.getTransactions(intoAcct, '2000-01-01', '2100-01-01');
    assert.ok(!intoRows.some((t) => t.imported_id === pair.into.id),
      'the stale leg must be gone, not left beside the transfer');

    // Idempotence over the destructive path: a third pass must delete nothing more.
    const again = await loadRows(rows, mapping, api, rateLookup, opts);
    assert.equal(again.transfersRelinked, 0, 'a relinked pair must not be relinked again');
    assert.equal(again.imported, 0, 'and must not be rewritten');

    // Actual creates the counterpart leg unchecked whatever the written leg says, so the loader
    // clears it. Checked here rather than only in a stub, because the unchecked default IS
    // Actual's behaviour and a stub is exactly the wrong place to prove what Actual does.
    for (const id of [trust, wise]) {
      for (const t of await api.getTransactions(id, '2000-01-01', '2100-01-01')) {
        if (!t.transfer_id || t.imported_id) continue;
        assert.ok(t.cleared, `a transfer mirror was left unchecked: ${t.date} ${t.amount}`);
      }
    }
    console.log('relink: every transfer mirror is cleared');
    console.log(`relink: stale leg deleted, ${joined.length} transfer written, `
      + `idempotent on the next pass (balances ${before.join('/')} -> ${(await balances()).join('/')})`);
  });

} finally {
  await api.shutdown();
  rmSync(dataDir, { recursive: true, force: true });
}
