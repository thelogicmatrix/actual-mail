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
import { loadRows, inScope, fxDatesFor } from '../src/load/load.js';
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
    // Every account the rows actually name, not three hardcoded Trust keys. The README teaches
    // `--source all` everywhere, whose first Wise row carries `wise-<currency>` — unmapped, and
    // loadRows hard-throws on an unmapped account, so the documented pipe died here. Derived
    // this way it also works for any parser a contributor adds.
    const mapping = Object.fromEntries([...new Set(rows.map((r) => r.account))].map((a) => [a, trust]));
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
    console.log(`pass 2: imported ${second.imported}, already present ${second.alreadyPresent}`);

    const all = await api.getTransactions(trust, '2000-01-01', '2100-01-01');
    const ids = all.map((t) => t.imported_id).filter(Boolean);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);

    console.log(`Trust holds ${all.length} transaction(s), ${new Set(ids).size} distinct imported_id`);
    assert.equal(dupes.length, 0, `re-import duplicated ${dupes.length} row(s): ${dupes.slice(0, 3)}`);
    assert.equal(all.length, first.imported, 'second pass must add nothing');

    // Every pot move must have landed as a linked transfer, not a spend.
    for (const pot of POTS) {
      const potTxns = await api.getTransactions(mapping[`pot:${pot}`], '2000-01-01', '2100-01-01');
      // inScope(), not another `slice(0, 10)`: the UTC day disagrees with the Singapore day
      // loadRows filters by, so near a month end this assertion fired on a correct import.
      const expected = willImport.filter((r) => r.type === 'pot_transfer' && r.payee === pot).length;
      console.log(`  pot "${pot}": ${potTxns.length} transaction(s), expected ${expected}`);
      assert.equal(potTxns.length, expected, `pot "${pot}" did not receive the other side`);
      for (const t of potTxns) assert.ok(t.transfer_id, `pot "${pot}" txn is not a linked transfer`);
    }

    console.log('\nOK — dedup holds and every pot move is a two-sided transfer.');
  });
} finally {
  await api.shutdown();
  rmSync(dataDir, { recursive: true, force: true });
}
