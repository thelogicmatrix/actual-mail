# actual-mail — Architecture

> Every behavioural claim carries a runnable check or resolvable citation (fidelity rule).

## How it works

One package, two bins, joined only by a pipe. Part 1 extracts, Part 2 loads, and the JSONL
between them is the whole interface.

**Part 1 — extraction (`src/`, entry `bin/actual-mail.js`)**

| Module | Responsibility |
|---|---|
| `src/cli.js` | argument parsing (`--since`, `--format`, `--source`), orchestration, exit code |
| `src/imap.js` | IMAP fetch and MIME decode, including quoted-printable before any regex runs |
| `src/parsers/index.js` | the parser registry — an explicit list, one entry per bank |
| `src/parsers/trust-sg.js` | Trust Bank alert-email parsers, one per message shape |
| `src/parsers/uob-sg.js` | UOB alert-email parsers, one per message shape |
| `src/sources/wise.js` | Wise API client |
| `src/row.js` | the normalised row, and the deterministic row id |
| `src/output.js` | CSV and JSONL rendering |
| `src/retry.js` | the one retry policy both sources use — the resolver blips, not the services |

**Part 2 — loading (`src/load/`, entry `bin/actual-mail-load.js`)**

| Module | Responsibility |
|---|---|
| `src/load/load.js` | reads JSONL on stdin, maps accounts, dedupes, writes to Actual |
| `src/load/fx.js` | foreign-amount conversion (ECB reference rate, plus a measured blended markup on alert-derived rows only) |
| `src/load/transfers.js` | which rows are two sides of one internal movement, and which single rows name their own counterparty account |

Both halves ship in one package on purpose. The extract/load seam is the pipe, not the npm
registry, so Part 1 stays Actual-agnostic and a non-Actual consumer simply ignores the second
bin. Recorded in DECISIONS, 2026-08-03.

**The operational shell (`scripts/`)** is what makes it a running system rather than a command:
`run.sh` is the driver (cadence, archive, lock, alert, heartbeat), `watchdog.sh` is the
dead-man's switch on its own cron entry, and `test-run-sh.sh` drives the real `run.sh` against
stubbed `docker` and `curl`. The remaining scripts are developer tools: `harvest.js`,
`inventory.js`, `extract-formats.js`, `extract-variants.js`, `probe-unmatched.js`,
`probe-wise.js`, `fx-calibrate.js`, `fx-report.js`, `verify-mailbox.js`, `verify-scratch.js`,
`list-accounts.js`, `set-env-value.js`, `scan-pii.js`, and `redact.js` for building fixtures.

**The seam is load-bearing.** Part 1 never converts currency: it emits the foreign amount
honestly, so an FX bug cannot contaminate the extraction record. Part 1 also has no idea Actual
exists, which is what makes its CSV useful to YNAB, Firefly III, Beancount or a spreadsheet.

**The unparsed invariant** governs every run. A fetched message must match a parser, match the
ignore-list (no money token, so marketing mail does not trip the run), or be reported as
`UNPARSED <id> <subject>` with a non-zero exit. There is no fourth outcome and no silent skip.
Parsed rows are still written before the exit code is set, so one unrecognised email never
discards the batch that parsed correctly. Checked by `test/cli.test.js`.

The same rule holds one level up, over **sources**. Trust and Wise are fetched and caught
independently: an unreachable source is reported as `SOURCE FAILED <source>: <reason>` with a
non-zero exit, and the other source's rows are still written. It did not hold until
2026-07-29, when a DNS blip on the Wise call ended the process before stdout and took that
run's Trust rows with it.

## Data flow

```
IMAP mailbox ──┐
               ├─→ src/imap.js ─→ src/sources/*.js ─→ src/row.js ─→ src/output.js ─→ CSV / JSONL
Wise API ──────┘                                       (row id)                          │
                                                                                         │ stdin
                                    Actual Budget ←── src/load/load.js ←── bin ──────────┘
                                                          │
                                                     src/load/fx.js (foreign rows only)
```

Row ids are hashed from source plus raw reference, which is what makes re-runs idempotent.
Dedup happens in our code on that id, not in Actual: Actual's own importer fuzzy-matches on
amount and payee and silently drops, which swallowed two genuine spends against same-amount
manual entries days earlier while still reporting success.

The reconciliation floor (`ACTUAL_MAIL_RECONCILED_THROUGH`) is required for a real import and
skips rows dated on or before it, counting what it skipped. Reconciliation is a human action;
without the floor a run backfills history already balanced by hand, and hand-entered rows carry
no `imported_id` so nothing else would stop the duplicates.

Dates use `sgDay()`, fixed +08 arithmetic with no ICU dependency. Trust stamps an SGT offset and
Wise answers in UTC, so taking `slice(0,10)` off whichever string arrived booked every Wise
movement between midnight and 08:00 SGT a day early, and across a month end into a closed
month. The same slice drove the reconciliation floor, so a shifted row could drop for good as
`skipped`.

## Where the base currency enters

`src/load/fx.js` reads the base currency in one place, inside `baseCurrency()`, and
`bin/actual-mail-load.js` compares every row against it to decide which rows are foreign. That
single read is the reason a non-SGD deployment is a configuration change rather than a code
change, and it is why the loader's own tests delete the variable from the environment before
running: a base currency inherited from the ambient shell would make the suite's answer depend on
who ran it. The markup over the ECB reference rate is configurable for the same reason, since a
spread measured on one card is not evidence about another. Recalibrate with
`scripts/fx-calibrate.js`.

The markup applies to **alert-derived rows only**. A card alert names an amount the bank has not
yet settled, so the markup is a genuine estimate of a spread that will be charged. A Wise row
comes from the API after the fact and the conversion has already happened at Wise's own rate —
applying a spread there models a cost nobody incurred and books every such row about 0.3% away
from mid, systematically, in one direction. Sources exempt from the markup are named in
`NO_SPREAD_SOURCES` rather than inferred, so adding an API-backed source is a deliberate act.

The full environment surface, including these, is tabulated once in the
[README](../README.md). It is not restated here.

## Soft spots

- **Redaction is only as complete as your `private.local.json`.** `scripts/redact.js` reads its
  literal rules from that gitignored file (template: `private.example.json`), so a literal you
  forget to list is not redacted. `scripts/scan-pii.js` is the backstop, but it catches the
  omission at the gate rather than at redaction time.
- **A green `scan-pii.js` is a PII gate, not an infrastructure review.** No rule in it looks for
  a hostname, an absolute host path or a git remote name, so those need a human read of the docs
  before any publish.
- **Alert amounts are authorisation, not settled.** FX rows are estimates by construction and
  domestic rows can still differ if a hold settles at a different amount. Every estimated row
  says so in its note.
- **Cross-source double-count, narrowed rather than closed.** A transfer between two of your own
  accounts appears in both feeds. `src/load/transfers.js` pairs the two legs and one transaction is
  written carrying the target's transfer payee, so nothing inside a run is flagged by hand — but
  only where all five conditions hold: same in-scope batch, same currency, within `WINDOW_MS`,
  non-zero and equal and opposite in minor units, different resolved Actual account ids, and mutual
  uniqueness. In scope means after the reconciliation floor, so a pair the floor splits is not
  booked as a transfer — though a second pairing pass over the unfiltered rows still counts the
  missing leg as evidence, which is what stops the survivor inventing one from its payee.
  Four things that are therefore still manual. Legs that arrive in *different* runs cannot pair at
  all, since a source down for a run separates them. **Cross-currency transfers are not detected**,
  since two legs in different currencies are not equal and opposite and identifying the pair would
  depend on an FX rate. Legs with more than one candidate between them are **refused as ambiguous**
  rather than guessed at, and import as ordinary transactions. And a pair with one leg already in
  the budget is deliberately not treated as a pair: both rows go through as ordinary transactions
  so the new leg is still written, and the count says a transfer was left unlinked.
- **`transfersAlreadySeparate` under-reports, by construction.** It increments only where `pairRows`
  actually paired two rows and the budget check then refused them, so a run holding one leg alone
  counts nothing and reports nothing — the split shows up only once a later run's extract window
  holds both rows again. The bundled seven-day sweep guarantees that. A hand-run `--since`, or a
  source down for longer than the window, does not, and those legs are never reported at all.
- **The transfer *booking* path has never run against live mail.** The 2026-08-27 verification
  exercised detection, the refusal of a same-instant currency conversion inside one account, and the
  degrade to ordinary transactions — but every live pair had one leg in the budget already, so no
  transfer was actually written. That path rests on `test/load/` and on nothing else.
- **FX depends on an external rate service.** If frankfurter.dev is unreachable, a run
  containing a foreign row fails rather than importing a guessed number. That is the intended
  trade, but it means a third-party outage is a failed run.
- **The watchdog cannot cover its own channel.** If `config.env` is what went missing, neither
  `run.sh` nor `watchdog.sh` can alert, because the webhook lives in it. Closing that needs a
  checker on a different host, and the limit is stated in the file rather than pretended away.
- **`scripts/test-run-sh.sh` is Linux-only** (`flock`), so its checks do not run on a Windows
  dev box. The unit suite does: `node --test` from the repo root already
  includes `test/load/`.
- **The test suite proved able to pass over an undeliverable alert channel.** It stubbed `curl`
  and asserted an alert was *attempted* rather than *deliverable*, so the failure webhook was
  broken for the entire life of the project without a single red test. Assertions here should
  target observable outcomes, not call sites. The lesson took three passes to apply everywhere:
  `run.sh` checked the status first, then `alert()` was found stamping its dedupe slot *before*
  the POST — so a rejected alert counted as reported and the next identical fault was suppressed
  — and `watchdog.sh`, the last-resort net, was still exiting "alert sent" without looking at the
  response at all. Attempted-versus-delivered is worth re-asking of every outbound call, not
  fixed once.
