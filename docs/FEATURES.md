# actual-mail — Features

🟢 live · 🔵 built · 🟡 planned · ⚪ idea

| Feature | Status | What it does |
|---------|--------|--------------|
| Trust alert-email extraction | 🟢 live | Parses Trust Bank transaction alerts into normalised rows. Four message families across a dozen patterns, three word orders for card spends |
| UOB Singapore alert emails | 🔵 built | Parses funds transfers, PayNow, NETS QR and ATM withdrawals. A 12-hour clock, two-digit years and two field orders, every shape derived from real mail and pinned by a redacted fixture |
| Wise API source | 🟢 live | Pulls Wise movements through the real API rather than mail |
| Unparsed invariant | 🟢 live | Every message parses, is ignored, or fails the run with `UNPARSED` and a non-zero exit. No silent skip |
| CSV / JSONL output | 🟢 live | `--format csv\|jsonl`. CSV is consumable by YNAB, Firefly III, Beancount or a spreadsheet |
| Deterministic row ids | 🟢 live | Hashed from source, raw reference and account, so re-runs are idempotent and two balances mapped to one Actual account cannot collapse into one row |
| Actual loader | 🟢 live | Reads JSONL on stdin, maps accounts, writes to Actual |
| Own dedup on row id | 🟢 live | Replaces Actual's `importTransactions`, which fuzzy-matched and silently dropped two real spends |
| FX conversion | 🟢 live | ECB reference rate, applied only in Part 2. Alert-derived rows carry a measured blended markup, because the settled figure is unknown and the bank's spread is real; API-sourced rows (Wise) convert at mid with no markup, because no spread was charged. Estimated rows are noted as such |
| Configurable base currency | 🟢 live | `BASE_CURRENCY` (default `SGD`) decides which rows count as foreign, so a non-SGD adopter gets correct conversion. `FX_MARKUP` sets the spread |
| Untracked source accounts | 🔵 built | `untracked:<key>` in `mapping.json` (value `null`) says a source account is deliberately outside the budget, and the ordinary key for it must be removed — while it resolves the account can still be written to as a transfer target. Rows are set aside before the reconciliation floor, before transfer pairing and before any FX fetch, counted on the run line, and the keys in force are listed on stdout with the rows each matched. One entry per non-base balance. A near-miss prefix, a non-null value, a key over a pot target and a surviving ordinary key all stop the run, reported together, because an inert licence writes the money it should have set aside |
| Pot moves as two-sided transfers | 🟢 live | Money leaves one account and arrives in the other, rather than booking as a spend |
| Internal transfers detected and booked two-sided | 🔵 built | Two rows within two minutes, same currency, equal and opposite, resolving to different Actual accounts and each the other's only candidate, become one transfer. Ambiguity is refused rather than guessed. A payee naming one of your own accounts books the far side from a single row, but only into an account licensed in `mapping.json` as one whose bank was measured to send no inbound alert |
| Cross-run transfers relinked | 🔵 built | When one leg arrived in an earlier run and is already an ordinary transaction, the stale row is DELETED and the pair is written fresh as one transfer, counted as `N transfer(s) relinked` and each deletion named on stdout. Delete-and-create rather than converting in place, because Actual accepts a payee change onto an existing row and silently declines to create the counterpart. Refused, falling back to reporting, when the existing row is reconciled or already part of a transfer |
| Reconciliation floor | 🟢 live | `ACTUAL_MAIL_RECONCILED_THROUGH` skips settled rows and counts them. Required for a real import |
| Dry run | 🟢 live | `ACTUAL_MAIL_DRY_RUN=1` runs the same `loadRows` against the same live budget and stubs only the write, so the already-present count is real. Prints `DRY` lines on **stdout** — they carry an amount and a payee, and the loader's stderr is what the alert reason is derived from — and drops the mandatory reconciliation floor |
| Cleared-on-import | 🟢 live | Rows land cleared |
| Categorisation rules | 🟢 live | Pre-stage `imported_payee contains` payee rules, since the payee text comes from the bank rather than Actual's matcher |
| Container | 🟢 live | Plain `docker run` joining a named network, so the Actual server is reachable as a sibling container. No compose needed |
| Two cadences | 🟢 live | 05:30 sweep (7-day window, reports what the top-up held back) and hourly top-up 06:15-23:15 (1-day window, alerts only on a new fault). A source outage waits until it has failed three of its last six runs, on either cadence. Cadence comes from the caller, never from reading the clock |
| Per-run archive | 🟢 live | Sweep writes `runs/<date>.jsonl`, top-up writes `.partial.jsonl`, so a 7-day filename never holds one day of answer |
| Alert budget | 🟢 live | One memory slot per channel, fingerprint taken over the fault with counting lines stripped. A standing failure costs one message a day |
| Webhook failure alerting | 🟢 live | `ALERT_WEBHOOK_URL` takes any service accepting a JSON POST with a `content` field. The body is the **curated reason line**, never raw stderr — only text this project composed itself leaves the host. Payload built by `json.dumps`, HTTP status checked, rejected alerts logged. Failures only |
| Push heartbeat | 🟢 live | `HEARTBEAT_URL` beats per run for Uptime Kuma, Healthchecks.io, Cronitor or similar. Unset means no heartbeat and never a failed run |
| `run.log` on every run | 🟢 live | Including skipped and suppressed runs, plus import counts and the failure reason. Silence no longer proves health |
| Concurrency lock | 🟢 live | `flock` on `.lock`, each container leg bounded by `timeout 600` |
| Dead-man's switch | 🟢 live | `scripts/watchdog.sh` at 07:00, shares no code with `run.sh`, alerts if `runs/.last-complete` has not moved in 90 minutes. It reads that sentinel rather than `run.log` because an aborted run still appends to the log |
| PII gate | 🟢 live | `scripts/scan-pii.js` scans tracked files and, with `--all-revs`, history and commit metadata. `redact.js` takes its literals from a gitignored `private.local.json` |
| Scratch-budget verifier | 🟢 live | `scripts/verify-scratch.js` imports twice into a throwaway local budget and asserts the second pass adds nothing |
| CI | 🟢 live | `.github/workflows/ci.yml` — suite on Node 20 and 22, the working-tree PII gate, the shell checks on a runner that has `flock`, and a `docker build` plus `--help` smoke on both entrypoints |
| Public release | 🔵 built | The gate passes on the working tree and on every revision — `scripts/scan-pii.js --all-revs` reads every blob and every commit message in every commit. Publication itself is pending |
| Off-host watchdog | ⚪ idea | The one failure neither script can report is a missing `config.env`, since the alert webhook lives in it |
