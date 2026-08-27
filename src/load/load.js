import { baseCurrency } from './fx.js';
import { rowId, toMinorUnits } from '../row.js';
import { pairRows, namedAccount } from './transfers.js';

// Trust alerts carry an SGT offset (`...+08:00`), the Wise API answers in UTC (`...Z`), and
// the calendar day used to be taken off the front of whichever string arrived. That booked
// every Wise movement between midnight and 08:00 SGT to the day before, and at a month
// boundary into the previous MONTH — the one error a budget cannot correct for itself, since
// it moves real spend into a period that was already closed. Both sources now resolve to the
// Singapore day explicitly.
//
// Plain arithmetic rather than Intl, deliberately: Singapore has been a fixed UTC+8 with no
// DST since 1982, so there is no rule to get wrong, and this cannot depend on how much ICU
// data the runtime image happens to ship.
export function sgDay(isoish) {
  return new Date(new Date(isoish).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Which dates need an FX rate fetched, and which rows are in scope at all. Both live HERE, in the
// same file as the `sgDay(row.date)` that loadRows looks the rate up by, because the derivation
// and the lookup MUST agree on how a date is derived and previously did not: the caller in bin/
// used `slice(0, 10)`, the UTC day, so every foreign row stamped 16:00-24:00 UTC bought a rate
// under a key nobody would request and the lookup then threw, taking the whole batch down. A
// comment in that caller told it to use sgDay and the line below it did not. Co-located functions
// with a test beat a comment asking another file to agree.
//
// inScope filters the reconciliation floor the same way loadRows does, so a run whose only
// foreign rows are already reconciled does not need the rate service to be up.
export function inScope(rows, reconciledThrough = null) {
  return rows.filter((r) => !reconciledThrough || sgDay(r.date) > reconciledThrough);
}

export function fxDatesFor(rows, base = baseCurrency()) {
  return rows.filter((r) => r.currency !== base).map((r) => sgDay(r.date));
}

export function toActualTxn(row, fx = null) {
  const foreign = row.currency !== baseCurrency();
  if (foreign && !fx) throw new Error(`no FX rate for ${row.currency} on ${sgDay(row.date)}`);

  const txnDate = sgDay(row.date);
  let amount;
  // The note field belongs to the user. A source:type tag on every row said nothing the
  // account and payee didn't already say, and it crowded out hand-written notes.
  // FX rows below are the exception: their note carries a warning, not a label.
  let notes = null;

  if (foreign) {
    // The only float in a money path, and only because the rate itself is one. Acceptable
    // solely because these rows are declared estimates and say so in their note.
    //
    // A markup is a spread the bank keeps, so it ALWAYS costs the customer: a debit takes more
    // out than mid-market, a credit puts less back in. So the sign selects the direction —
    // (1 + markup) on money out, (1 - markup) on money in.
    //
    // `signed * (1 + markup)` is the obvious form and is wrong for credits: it moves a refund
    // further from zero, crediting MORE than mid-market, so a refund came out wrong by twice the
    // markup in the customer's favour and reconciliation would chase it as a real discrepancy.
    // `Math.abs(signed) * (1 + markup) * Math.sign(signed)` looks like a fix and is the same
    // expression — that version was written here first and the test below refuted it.
    // trust-sg.js emits refunds and cancellations as positive rows, so this path is live.
    const signed = Number(row.amount);
    const spread = signed < 0 ? 1 + fx.markup : 1 - fx.markup;
    // Math.round breaks an exact half UPWARDS, which on a negative amount rounds toward zero:
    // -13540.5 became -13540 while +13540.5 became 13541, so a tie favoured the customer in
    // both directions. Rounded away from zero on both sides instead, so the sign of a row can
    // never change its magnitude.
    const cents = signed * fx.rate * spread * 100;
    amount = cents < 0 ? -Math.round(-cents) : Math.round(cents);
    const rateNote = fx.rateDate === txnDate
      ? `ECB ${fx.rateDate}`
      : `ECB rate date ${fx.rateDate}`;
    notes = `FX ${row.currency} ${row.amount.replace('-', '')} @ ${fx.rate.toFixed(6)} est `
      + `(${rateNote} +${(fx.markup * 100).toFixed(2)}%) - verify at settlement`;
  } else {
    // Integer arithmetic on the decimal string. Math.round(Number('19.99') * 100) is the
    // obvious alternative and is wrong often enough to matter.
    amount = toMinorUnits(row.amount);
  }

  return {
    date: txnDate,
    amount,
    payee_name: row.payee,
    imported_id: row.id,
    // The alert IS the bank confirming the transaction, so these land cleared. FX rows are
    // still estimates and say so in their note — cleared means "the bank did this", not
    // "the amount is final".
    cleared: true,
    notes,
  };
}

export async function loadRows(rows, mapping, api, rateLookup = () => null, opts = {}) {
  const { reconciledThrough = null, transferPayeeFor = null, onTransfer = () => {} } = opts;
  const byAccount = new Map();
  const legacyIds = new Map();
  let converted = 0;
  let transfers = 0;
  let transfersAlreadySeparate = 0;

  // The floor is applied HERE rather than inside the loop, because transfer pairing must see
  // exactly the rows that will be written. A pair whose other leg is already reconciled is
  // not a pair, and pairing before the floor would book half a transfer against a leg that
  // was then dropped. inScope() is the same function bin/actual-mail-load.js validates the
  // mapping against, so the two cannot disagree about what "in scope" means.
  //
  // Reconciliation is a human action, and anything up to and including the reconciled date is
  // settled. Importing it would be backfill into an already-balanced account. inScope compares
  // the same Singapore day the row is written with: a UTC-derived day would drift a Wise row
  // across the floor and drop it permanently, counted only as `skipped`, which nothing surfaces.
  const scoped = inScope(rows, reconciledThrough);
  const skipped = rows.length - scoped.length;

  // A caller that cannot resolve transfer payees degrades to ordinary transactions rather
  // than throwing. bin/actual-mail-load.js always supplies one.
  const canTransfer = typeof transferPayeeFor === 'function';
  const { pairs, ambiguous } = canTransfer
    ? pairRows(scoped, mapping)
    : { pairs: [], ambiguous: 0 };

  // The written leg's target and partner, and the set of legs Actual will create for us.
  const pairedOut = new Map(pairs.map(({ out, into }) => [out.id, into]));
  const suppressed = new Set(pairs.map(({ into }) => into.id));

  for (const row of scoped) {
    // The mirror of this leg is created by Actual from the other side, so writing it here
    // would double the money. Its id still reaches the budget, joined onto the written
    // leg's imported_id below, which is what stops it re-importing later.
    if (suppressed.has(row.id)) continue;

    const txnDate = sgDay(row.date);

    const accountId = mapping[row.account];
    // A silently dropped account is exactly the quiet data loss this project exists to
    // avoid, so an unmapped account is a hard error.
    if (!accountId) throw new Error(`no Actual account mapped for "${row.account}"`);
    // The source goes to the lookup: the markup models a bank's spread and an API source that
    // reports the currency it holds charged none. See NO_SPREAD_SOURCES in fx.js.
    const fx = row.currency === baseCurrency() ? null : rateLookup(txnDate, row.currency, row.source);
    if (fx) converted += 1;

    const txn = toActualTxn(row, fx);
    if (row.type === 'pot_transfer') {
      // The pot is its own Actual account, so this is a transfer between two accounts, not
      // a spend. Actual links both sides when the payee is the target's transfer payee.
      const potAccountId = mapping[`pot:${row.payee}`];
      if (!potAccountId) throw new Error(`no Actual account mapped for pot "${row.payee}"`);
      delete txn.payee_name;
      txn.payee = transferPayeeFor(potAccountId);
    } else if (canTransfer) {
      // Two ways to know this row is an internal transfer, and both are needed because the
      // banks are asymmetric. A paired partner row is the evidenced case. A payee naming one
      // of your own accounts is the only case that works when the receiving bank sends no
      // alert at all, which UOB was verified to do on 2026-08-27.
      const partner = pairedOut.get(row.id);
      const targetKey = partner ? partner.account : namedAccount(row, mapping);
      const targetId = targetKey ? mapping[targetKey] : null;
      // A payee naming the row's OWN account is not a transfer, it is a note to self.
      if (targetId && targetId !== accountId) {
        delete txn.payee_name;
        txn.payee = transferPayeeFor(targetId);
        // Both ids, so the leg Actual creates for us — which carries no imported_id of its
        // own — cannot come back as a standalone duplicate on the next run.
        if (partner) txn.imported_id = `${row.id}+${partner.id}`;
        transfers += 1;
        onTransfer({ date: txn.date, amount: txn.amount, from: accountId, to: targetId });
      }
    }

    // ponytail: transitional. Rows imported before the account joined the row id carry
    // sha256(source\0raw_ref) as their imported_id in the budget; the dedupe below checks that
    // id as well as the current one so nothing already imported comes back as new spend. No
    // migration, no imported_id in the live budget is ever rewritten — only the NEW id is
    // written from here on. Delete this map and the second `seen.has` once
    // ACTUAL_MAIL_RECONCILED_THROUGH is past the last run made under the old id, because from
    // that point no old-id row is in scope to collide with.
    //
    // A LIST, because a transfer's transaction stands for two rows and either one could be
    // sitting in the budget under a pre-account id. Storing only the written leg's legacy id
    // would let the suppressed leg re-import from a pre-2026-08-06 budget entry.
    if (row.source && row.raw_ref) {
      const legacy = [rowId(row.source, row.raw_ref)];
      const partner = pairedOut.get(row.id);
      if (partner?.source && partner.raw_ref) legacy.push(rowId(partner.source, partner.raw_ref));
      legacyIds.set(txn.imported_id, legacy);
    }

    if (!byAccount.has(accountId)) byAccount.set(accountId, []);
    byAccount.get(accountId).push(txn);
  }

  // addTransactions, not importTransactions. Actual's importer fuzzy-matches an incoming
  // row against existing ones by amount and payee within a date window, and silently drops
  // it as already-seen. Two genuine spends of $3.18 and $8.30 on 2026-07-28 vanished that
  // way against hand-entered rows of the same amounts days earlier, while the run still
  // reported success. Dedup on our own deterministic imported_id instead: it matches the
  // same row and nothing else, and what it skips it counts out loud.
  let imported = 0;
  let alreadyPresent = 0;
  try {
    for (const [accountId, txns] of byAccount) {
      const dates = txns.map((t) => t.date).sort();
      // Split on '+', because a transfer's imported_id joins the ids of BOTH rows it stands
      // for. Reading it back as one opaque string would let either leg re-import: the leg
      // Actual mirrored for us carries no imported_id at all, so the joined id is the only
      // record that its row was ever seen. A sha256 hex digest never contains '+'.
      //
      // The joined id goes in WHOLE as well as in parts. Nothing matches it — a part and a
      // legacy id are both single digests — so it costs nothing, and it is what lets the
      // filter below tell an already-written transfer apart from a pair whose legs are in the
      // budget separately. Without it that test reads `!seen.has(whole)` against a set that
      // can only ever hold parts, and every healthy re-run reports a phantom split pair.
      const seen = new Set();
      for (const t of await api.getTransactions(accountId, dates[0], dates.at(-1))) {
        if (!t.imported_id) continue;
        seen.add(String(t.imported_id));
        for (const part of String(t.imported_id).split('+')) seen.add(part);
      }
      // The predicate ADDS to `seen`, which is what makes the filter dedupe the incoming batch
      // against ITSELF as well as against the account. Two rows carrying one imported_id were
      // both written before that: the account had neither yet, so neither was "already present".
      // Reachable by concatenating two archives from runs/, re-piping a file, or any upstream
      // double-delivery. The second `seen.has` is the pre-account id — see legacyIds above.
      const fresh = txns.filter((t) => {
        const parts = String(t.imported_id).split('+');
        const legacy = legacyIds.get(t.imported_id) ?? [];
        if (parts.some((p) => seen.has(p)) || legacy.some((l) => seen.has(l))) {
          // A pair whose legs were each imported separately by earlier runs. Both parts are
          // already in the budget as ordinary transactions, so writing the transfer now
          // would be a third copy of the same money. Reported rather than linked: linking
          // would mean editing transactions already in the budget.
          if (parts.length > 1 && !seen.has(t.imported_id)) transfersAlreadySeparate += 1;
          return false;
        }
        for (const p of parts) seen.add(p);
        return true;
      });
      alreadyPresent += txns.length - fresh.length;
      // runTransfers defaults to false, and without it a pot move debits the main account
      // and the pot side is never created — money that leaves and arrives nowhere.
      if (fresh.length) await api.addTransactions(accountId, fresh, { runTransfers: true });
      imported += fresh.length;
    }
  } catch (e) {
    // This loop writes one account at a time, and the caller syncs only once it returns. A throw
    // on the second account therefore left the first account's rows written to the LOCAL budget
    // and never synced — and the next run's dedupe reads that same local cache, sees the
    // imported_id and counts them `alreadyPresent`. Never rewritten, never resynced, invisible
    // forever, while every run afterwards reports healthy. (api.shutdown() does sync, inside its
    // own `catch {}`, so it cannot be relied on either.) Sync what landed, THEN rethrow: the run
    // still fails loudly, but the local cache is not lying to the retry.
    if (imported > 0 && typeof api.sync === 'function') {
      // A failed sync here changes nothing worth reporting over the failure being rethrown —
      // that one is already fatal and names the real cause.
      try { await api.sync(); } catch { /* the original throw is the one that matters */ }
    }
    throw e;
  }
  return { imported, converted, skipped, alreadyPresent, transfers, transfersAlreadySeparate, ambiguous };
}
