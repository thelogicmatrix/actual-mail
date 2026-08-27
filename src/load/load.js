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

// The mapping key prefix that records a measurement: this account's bank sends no inbound
// alert. Same convention as `pot:`, and it lives in mapping.json for a reason beyond tidiness —
// the entries name real account keys, and every account digit in a committed file must be 0000.
// See mapping.example.json for the shape.
//
// Exported so bin/actual-mail-load.js's orphan-licence warning cannot drift from the prefix
// this file actually honours: a mismatched copy there would warn about nothing while real
// orphan licences stayed silent, which is the failure the warning exists to catch.
export const NO_INBOUND_ALERT = 'no-inbound-alert:';

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
  // Accounts whose bank was MEASURED to send no inbound alert, and nothing else. Named rather
  // than inferred, so adding one is a deliberate act — the same shape as NO_SPREAD_SOURCES in
  // fx.js, and for the same kind of reason: an exemption that is only true because somebody
  // went and checked.
  const noInboundAlert = new Set(Object.keys(mapping)
    .filter((k) => k.startsWith(NO_INBOUND_ALERT)).map((k) => k.slice(NO_INBOUND_ALERT.length)));
  // Split on '+', because a transfer's imported_id joins the ids of BOTH rows it stands for.
  // Reading it back as one opaque string would let either leg re-import. The joined id goes
  // into the set WHOLE as well as in parts: nothing can match it — a part and a legacy id
  // are both single digests — but it is what lets the filter below tell an already-written
  // transfer apart from a pair whose legs are in the budget separately, and without it every
  // healthy re-run of every transfer reported a phantom split pair. A sha256 hex digest
  // never contains '+'.
  //
  // Read RUN-WIDE, before the first write, because a transfer's record lives in only ONE of
  // the two accounts it spans: the written leg carries the joined id and the leg Actual
  // mirrors for us carries no imported_id at all. Deduping a batch against its own account
  // alone therefore looked in the wrong place for the mirrored side, and the credit leg was
  // written a second time on top of money already booked. Both orderings reach it — the pair
  // first and then the credit leg alone, or the credit leg alone and then the pair — and
  // neither needs a re-piped file: SOURCE FAILED lines in runs/run.log mean one source being
  // down for a run is a path this system has already taken.
  //
  // CURRENT ids union run-wide, LEGACY ids stay per account, and that split is deliberate. A
  // row id hashes the account, so the same id under another account means that row was
  // written there under an earlier mapping and suppressing it is right — the money is booked,
  // just where the old mapping pointed. A legacy id hashes only source and raw_ref, so a
  // run-wide legacy match would re-open the loss recorded above legacyIds: one Wise balance
  // conversion appears in both balance statements under a single referenceNumber, so its two
  // legs share one legacy id, and where those balances map to different Actual accounts the
  // second leg would silently vanish as already present.
  // From the scoped ROWS, not the written transactions, because those exclude the suppressed
  // leg by construction. Two legs thirty seconds apart still fall on different Singapore days
  // across midnight, and a window built from the written side then covered only the written
  // leg's day: the right accounts read over the wrong dates, and the duplicate came back.
  const dates = scoped.map((r) => sgDay(r.date)).sort();
  const seen = new Set();
  const seenInAccount = new Map();
  // One read per MAPPED account, not per written-to account: an account with nothing to write
  // this run is exactly where a mirrored leg hides. No rows means no reads at all, rather than
  // asking the API for a date range this run has no dates for.
  //
  // Ahead of the row loop, not just ahead of the writes, because what the budget already holds
  // decides which pairs are pairs at all — see the pair filter below. Outside the try for the
  // same reason, which costs nothing: that catch exists to sync PARTIAL writes, and a read
  // failing here throws with nothing written, exactly what the catch would have concluded.
  //
  // ponytail: one read per mapped account, so this scales with the MAPPING rather than with
  // the batch — a run importing one row still reads every account. Fine at a handful of
  // accounts. If that stops being true, narrow it to the accounts a row could dedupe against:
  // the accounts being written to, plus the transfer target of every detected transfer.
  for (const accountId of dates.length ? new Set(Object.values(mapping).filter(Boolean)) : []) {
    const local = new Set();
    for (const t of await api.getTransactions(accountId, dates[0], dates.at(-1))) {
      if (!t.imported_id) continue;
      const id = String(t.imported_id);
      local.add(id);
      seen.add(id);
      for (const part of id.split('+')) { local.add(part); seen.add(part); }
    }
    seenInAccount.set(accountId, local);
  }

  const { pairs, ambiguous } = canTransfer
    ? pairRows(scoped, mapping)
    : { pairs: [], ambiguous: 0 };

  // A pair is only a pair against what the budget ALREADY holds, which is why the read above
  // happens first. Refusing a pair outright used to take the new leg down with it: the monthly
  // UOB-to-Trust transfer had its Trust credit in the budget from months of runs and its UOB
  // debit brand new — UOB was not mapped until today — and the whole pair was dropped, reported
  // only as `transfersAlreadySeparate`, a name that says both legs are present. The UOB account
  // was short by the full amount and nothing said so.
  //
  // Three cases, and only the third is new. Already written as a transfer: keep it, and the
  // dedupe below counts it alreadyPresent — NOT as a split pair, which would be the phantom
  // alarm this file already fixed once. Neither leg in the budget: write the transfer. One leg
  // present: not a pair at all. Both rows go through as ordinary transactions, the dedupe drops
  // the leg that is already there and writes the one that is not, and the count says a transfer
  // was left unlinked. Unlinked rather than joined up, because linking would mean editing
  // transactions already in the budget.
  //
  // Known gap, deliberately not solved: this tests CURRENT ids only. A leg sitting under a
  // pre-account legacy id is invisible here, so the pair is kept, written, and then dropped by
  // the legacy check in the dedupe — the same loss, unreported. The window is narrow: legacy
  // ids stopped being written on 2026-08-06 and no row below the reconciliation floor is in
  // scope to collide.
  const booked = pairs.filter(({ out, into }) => {
    if (seen.has(`${out.id}+${into.id}`)) return true;
    if (!seen.has(out.id) && !seen.has(into.id)) return true;
    transfersAlreadySeparate += 1;
    return false;
  });

  // The written leg's target and partner, and the set of legs Actual will create for us.
  const pairedOut = new Map(booked.map(({ out, into }) => [out.id, into]));
  const suppressed = new Set(booked.map(({ into }) => into.id));
  // Keyed by the transaction OBJECT, not its imported_id: two rows in one batch can carry one
  // id, and the object is what the dedupe filter hands back.
  const transferTo = new Map();

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
      // banks are asymmetric. A paired partner row is the evidenced case: two rows, one
      // movement. A payee naming one of your own accounts is the other, and it INVENTS the far
      // leg from a string — which is safe only where the receiving bank cannot produce a row of
      // its own to be booked beside it.
      //
      // Ungated, it doubled money. A debit naming its target got a transfer, Actual mirrored a
      // credit into that target, and the target's own inbound alert then imported as a third
      // row: the money arrived twice. Pairing does not save you, because pairing refuses
      // whenever it is not certain — more than one candidate, legs further apart than
      // WINDOW_MS, or a currency mismatch — and every refusal drops straight through to here.
      // Nor is one run the boundary: a source down for a run (SOURCE FAILED in runs/run.log)
      // separates the two legs into different runs, where they can never pair at all.
      //
      // So the list is the licence, and it is a measurement rather than an opinion. UOB was
      // checked on 2026-08-27: a transfer into it produced a debit alert from the sending bank
      // and nothing from UOB, still nothing seven minutes later, against outbound alerts that
      // normally arrive within thirty seconds. Adding an account here means making that same
      // measurement. A named account without one is an ordinary payee, exactly as an unmapped
      // account key already is.
      const partner = pairedOut.get(row.id);
      const named = partner ? null : namedAccount(row, mapping);
      const targetKey = partner ? partner.account : (noInboundAlert.has(named) ? named : null);
      const targetId = targetKey ? mapping[targetKey] : null;
      // A payee naming the row's OWN account is not a transfer, it is a note to self.
      if (targetId && targetId !== accountId) {
        delete txn.payee_name;
        txn.payee = transferPayeeFor(targetId);
        // Both ids, so the leg Actual creates for us — which carries no imported_id of its
        // own — cannot come back as a standalone duplicate on the next run.
        if (partner) txn.imported_id = `${row.id}+${partner.id}`;
        // Recorded here, COUNTED after the dedupe. This loop only detects; whether anything is
        // written is decided by the filter below. Counting here made a re-run that wrote
        // nothing still report a transfer and fire onTransfer again — an alarm about money
        // repeating on every run, which teaches the reader to stop reading the run line.
        transferTo.set(txn, targetId);
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
      const legacySeen = seenInAccount.get(accountId) ?? new Set();
      // The predicate ADDS to `seen`, which is what makes the filter dedupe the incoming batch
      // against ITSELF as well as against the account. Two rows carrying one imported_id were
      // both written before that: the account had neither yet, so neither was "already present".
      // Reachable by concatenating two archives from runs/, re-piping a file, or any upstream
      // double-delivery. It adds to the RUN-WIDE set, so a doubled batch dedupes against itself
      // across accounts too. The second test is the pre-account id, and it is the one thing
      // compared against this account alone — see legacyIds above and the split explained at
      // the fetch.
      const fresh = txns.filter((t) => {
        const parts = String(t.imported_id).split('+');
        const legacy = legacyIds.get(t.imported_id) ?? [];
        if (parts.some((p) => seen.has(p)) || legacy.some((l) => legacySeen.has(l))) return false;
        for (const p of parts) seen.add(p);
        return true;
      });
      alreadyPresent += txns.length - fresh.length;
      // runTransfers defaults to false, and without it a pot move debits the main account
      // and the pot side is never created — money that leaves and arrives nowhere.
      if (fresh.length) await api.addTransactions(accountId, fresh, { runTransfers: true });
      imported += fresh.length;
      // After the write, so `transfers` means "made this run" and the run log names a movement
      // of money exactly when one happened. A throw above reports nothing, matching the rows
      // that never landed.
      for (const t of fresh) {
        const to = transferTo.get(t);
        if (!to) continue;
        transfers += 1;
        onTransfer({ date: t.date, amount: t.amount, from: accountId, to });
      }
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
