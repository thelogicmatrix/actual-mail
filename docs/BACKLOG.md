# actual-mail — Backlog

> Item leaves on ship → FEATURES flips.

## Inbox

Raw drops go to [backlog/INBOX.md](backlog/INBOX.md).

## Triaged

- **Transient UNPARSED with no record of what.** An alert fired, the condition vanished, and
  `run.log` keeps no record of the offending message. The alert body carries it and the alert
  body is not kept, so the fix is to archive the offending subject line at the point `run.sh`
  still has it.
- **5 disclosed nits** from the review rounds, not yet picked up.
- **Off-host watchdog.** The one failure neither script can report is a missing `config.env`,
  since the alert webhook lives in it. Closing this needs a checker on a different host.
  Recorded as an idea in FEATURES, not yet a committed piece of work.
- **Cross-source double-count.** A transfer from the bank to Wise appears in both the Trust feed
  and the Wise API. Both sides are imported and the transfer is flagged manually in Actual.
  Automating the match is unstarted.
- ~~**`--source` accepts an unknown value silently.**~~ Closed 2026-08-05: `src/cli.js` rejects an
  unmatched `--source` with a non-zero exit naming the valid ids, covered by `test/cli.test.js`.
  Original note: **`--source` accepts an unknown value silently.** A typo exits 0 with zero rows
  and no diagnostic. Now that parser ids are a contributor-supplied namespace rather than two
  fixed literals, a typo is materially more likely.
- ~~**The parser id and the emitted `source` can diverge.**~~ Closed 2026-08-05: it is documented
  in `docs/WRITING-A-PARSER.md` under its own subsection, with the mechanism and a rule for
  contributors, and `test/fixture-coverage.test.js` enforces the directory naming. Original note:
  **The parser id and the emitted `source` can diverge.** `src/parsers/trust-sg.js` has id
  `trust-sg` and emits `source: 'trust'`, deliberately, because the row id hashes the source and
  changing it would break Actual's `imported_id` dedupe on every existing row. That divergence is
  part of the public contract and is documented nowhere.

## Building

Nothing in flight. The last shipped item was the public-release preparation: PII gate, redaction
by config, the rename to `actual-mail`, and one package with two bins.

## Deferred from the 2026-08-05 release DD gate

The gate raised 44 root issues. Groups B (money) and C (silent failure) were fixed in full that
day; these are the remainder, with the reason each was deferred rather than done.

- **A durable local ledger of written `imported_id`s.** Would fix three things at once: a deleted
  row returning (limitation 5), the dedup window being scoped to one account and one date range,
  and the read-then-write race (limitation 6). Deferred because it introduces a second source of
  truth about what was imported, and a ledger that drifts from the budget is worse than the
  window it replaces. `runs/*.jsonl` already carries every id, so the input exists.
- **`scripts/undo-run.js <runs/DATE.jsonl>`.** Read the ids, delete the matching transactions,
  print each one. ~30 lines against an existing format, and it turns "there is no undo" into a
  documented command. The strongest single item left.
- **Retention on `runs/`.** Plaintext transaction history, one file a day, never pruned and never
  rotated. Needs a stated window, and pruning must happen after the new archive is written.
- **`npm audit --audit-level=high` in CI, plus dependabot.** Three high-severity advisories are
  live today via `adm-zip` under `@actual-app/api`, fixed in 26.8.0 — but that is the bump this
  project deliberately pinned back, so it needs a money-path differential first.
- **`npm ci --ignore-scripts` in the Dockerfile.** `better-sqlite3` runs `prebuild-install`,
  which is deprecated and fetches a native binary with no checksum or signature check.
- **`USER node` in the Dockerfile.** Files written into the `cache/` bind mount are root-owned.
- **A high-water mark for Wise.** The window is a fixed 30 days with no record of the last
  success, so an outage longer than that loses data permanently. IMAP self-heals; Wise does not.
- **Range request for FX rates.** One HTTP round trip per distinct date, unretried, and the only
  network caller on the money path without a retry wrapper. (The missing *timeout* was a separate
  defect and is closed 2026-08-05: a bound is independent of the range work and was one argument.
  Without it a socket that accepted the connection and went quiet hung the loader indefinitely,
  holding the flock.)
- **README order.** A 119-line configuration reference sits ahead of "Known limitations", which
  starts 88% down the file — the facts that decide whether the tool fits you are ranked last.
- **The tutorial's worked example is only half executable.** Its published row id was wrong for
  months because nothing ran it; `test/row.test.js` now reads the id out of the doc and
  recomputes it, so that one number cannot drift again. The rest of the worked row — the nine
  other fields, and the parser itself — is still prose. Landing the example parser and fixtures
  in the tree, unregistered, makes `npm test` fail when any of it goes stale.
- ~~**Stop hardcoding counts in prose.**~~ Closed 2026-08-05: the last four wrong ones were
  removed rather than corrected, and a sweep finds no typed count left that the code could
  contradict. Original note: test and check counts drifted in nine places. Numbers that can be
  counted should not be typed.
