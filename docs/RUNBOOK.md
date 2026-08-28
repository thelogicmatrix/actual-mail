# actual-mail — Runbook

Operating procedures for a deployed instance. First-time configuration (bank alert thresholds,
`.env`, `config.env`, `mapping.json`, the reconciliation floor) lives in the
[README](../README.md) and is not repeated here.

This runbook is deliberately host-agnostic. Substitute your own paths for the placeholders.

## Where it lives

| Thing | Location |
|---|---|
| Source of truth | your clone of this repo, on `main` |
| Host copy | `<deploy-dir>/src`, a **clone** of that remote rather than a file copy. Build context only, since the running image is what `docker build` produced from it |
| Runtime state | `<deploy-dir>/runs/` (archives, `run.log`), `<deploy-dir>/cache/` (Actual data dir), `<deploy-dir>/.lock` |
| Config | `.env` (secrets), `config.env` (floor date, alert webhook, heartbeat URL), `mapping.json` |
| Cron | three entries, wherever your host makes cron durable |

Clone rather than copy for a reason worth keeping: a clone on Linux writes LF whatever a Windows
checkout holds, which is what a `git archive | tar x` copy kept getting wrong. It also lets the
host tell you which commit it is running.

Three cron entries:

| Entry | Schedule | Does |
|---|---|---|
| daily sweep | 05:30 | 7-day sweep, reports what the top-up held back (a source outage still waits three runs) |
| hourly top-up | `15 6-23 * * *` | 1-day top-up, alerts only on a new fault |
| watchdog | 07:00 | alerts if no run has COMPLETED in 90 minutes (`runs/.last-complete`) |

## Deploy a change

1. Commit on `main` and run the suite: `node --test`. Then push.
2. Pull on the host: `git -C <deploy-dir>/src pull --ff-only`. If `run.sh` or `watchdog.sh`
   changed, copy them from `src/scripts/` up to `<deploy-dir>/` — cron runs those top-level
   copies, not the ones in the tree.
3. Rebuild the image on the host, keeping the previous one for rollback:
   `docker tag actual-mail actual-mail:prev && docker build -t actual-mail .`
4. Run one cadence by hand before trusting cron, under a **bare environment** rather than your
   interactive shell, since cron has neither your PATH nor your locale.
5. Check `runs/run.log` for the new line, and your heartbeat monitor.

**Steps 2 and 3 land together or not at all.** `run.sh` defaults `IMAGE` to `actual-mail`, so
copying a new `run.sh` up while building the old image tag gives `docker run: Unable to find
image` at 05:30, in a cron job whose whole job is to be quiet. If you carry a different tag on
your host, set `ACTUAL_MAIL_IMAGE` there instead of renaming the build.

**Rollback** is `docker tag actual-mail:prev actual-mail`. Kept deliberately to one command.

**One-off, upgrading past 2026-08-05:** the source-failure gate moved from a consecutive-run
streak to a six-run window, so the old per-source state files are dead. `rm -f
<deploy-dir>/.fail-streak-*` after step 2. Nothing reads them, so leaving them is harmless
rather than wrong — but they will sit in the deploy directory forever otherwise.

**`--all-revs` is not clean in a clone that has fetched the private archive remote, and that is
expected.**
The gate walks `rev-list --objects --all` and `log --all`, and `--all` includes remote-tracking
refs — so it scans the private pre-flatten archive as well as `main`. Measured on 2026-08-28: 75
findings across 22 objects, of which **3 are reachable from `main`** and the rest are archive-only.
Before reading a non-zero count as a publication blocker, check reachability.

**A finding's leading sha is usually a BLOB, not a commit**, so `git merge-base --is-ancestor`
is the wrong tool and silently reports every blob as unreachable — which reads as "all clear"
and is the most dangerous possible way to be wrong here. Intersect object sets instead:

```sh
git rev-list --objects main | awk '{print $1}' | sort -u >/tmp/main-objs
npm run scan -- --all-revs 2>&1 | grep -oE '^[0-9a-f]{7,40}:' | tr -d ':' | sort -u |
while read -r s; do
  full=$(git rev-parse "$s")
  case "$(git cat-file -t "$s")" in
    blob)   grep -qx "$full" /tmp/main-objs && echo "REACHABLE blob   $s" ;;
    commit) git merge-base --is-ancestor "$s" main && echo "REACHABLE commit $s" ;;
  esac
done
```

Nothing printed means the publishable history is clean.

**Editing `scripts/scan-pii.js` or `test/scan-pii.test.js` makes their previous versions
visible to the gate**, because those two paths are exempt by CONTENT hash against the working
tree. The version you just replaced stops matching and is scanned like any other blob. That is
the documented refresh path, and it is why a count can jump on a commit that touched neither
PII nor history — read the new findings before pasting hashes into `SELF_REVIEWED`.

**One-off, upgrading past 2026-08-28:** the code half of untracked source accounts ships with
the push, but the half that turns it on is `mapping.json`, which is gitignored and lives only on
the deploy host. **Edit it in the same maintenance window as the pull**, or the run behaves
exactly as before and nothing says so. For each non-base-currency balance, **replace** the
ordinary key with an untracked one — with a single SGD Wise account that means deleting
`wise-aud` and `wise-usd` and adding `"untracked:wise-aud": null` and
`"untracked:wise-usd": null`. Both, not just the one that has already cost you a row. Keeping the
ordinary key beside the untracked one is refused by the loader, because while it resolves the
account can still be written to as a transfer target.

Confirm on the next run: stdout carries `untracked source account(s) in force` with a row count
beside each key. A key you expected to fire showing `0 rows this run` across a 7-day sweep is a
typo in the key half — the one mistake nothing refuses.

Rows already imported from those accounts are **not** revisited. Anything the old behaviour
wrote is still in the budget and has to be deleted by hand.

**Rollback ordering for that change:** restore the ordinary `wise-<ccy>` keys and delete the
`untracked:` ones in a **single edit**, then revert the code. Old code does not understand
`untracked:`, so a mapping carrying only those keys has no key for those accounts at all, and an
unmapped account is a hard error — every hourly run exits 1 until someone notices. Doing it in
one edit is what avoids that window in either direction.

**Also one-off, and it breaks step 2:** this repo was republished from a fresh root commit, so a
clone made before that has no common ancestor with it and `git pull --ff-only` fails with
`refusing to merge unrelated histories`. Do not force the merge — re-clone into a new directory
and move `config.env`, `mapping.json`, `.env`, `cache/` and `runs/` across. Every one of those
is gitignored, which is what makes a re-clone cheap rather than a migration.

## Verify it is actually working

A `DELETED <id> in <account>` line on stdout means a **relink**: the loader found a transfer whose
counterpart was imported in an earlier run, deleted that stale row and wrote the pair as one
two-sided transfer. It is the only destructive thing this tool does. The lines land in
`runs/cron.log` via the documented crontab redirect, never in the Discord body, because a
transaction id is budget data. A dry run says `WOULD DELETE` instead and deletes nothing.

Seeing `N transfer(s) relinked` repeatedly for the same amount would mean churn, and should not
happen: the written transfer carries a joined `imported_id`, so the next run short-circuits before
the relink branch. Two consecutive quiet runs after a relink is the check.


Silence does not prove health, which is why every run appends to `run.log` including runs that
were skipped or suppressed.

- **Is it running?** `tail runs/run.log`. The watchdog keys on `runs/.last-complete` rather than on this log, because a run that bails out early still appends here. Absence of recent lines is the failure the watchdog
  exists to catch.
- **Is it importing?** `run.log` carries import counts. `extract=0 load=0` alone cannot
  distinguish a healthy quiet day from a stale reconciliation floor silently discarding
  everything, so read the floor date too.
- **Why did it fail?** A non-zero stage writes `reason=[extract: …]` / `reason=[load: …]` on the
  same line, since 2026-08-03. `SOURCE FAILED <src>` is the resolver or a dead source and needs
  nothing; `matched no parser` is a bank changing its emails and needs a parser. Before that
  date the two were the same line, so a `run.log` older than 2026-08-03 cannot tell you which.
- **Is the alert channel alive?** A rejected alert writes a `REJECTED` line. The webhook was
  proven live on 2026-07-29 by a real alert being accepted, not by a test.
- **Idempotence check:** re-run the same window and confirm 0 imported with transaction ids
  unchanged.

## Routine tasks

**Bump the reconciliation floor** after reconciling in Actual: edit
`ACTUAL_MAIL_RECONCILED_THROUGH` in `config.env`. It is kept out of `.env` precisely so bumping a
date does not touch a secrets-managed file.

**Add a recurring merchant.** Actual does **not** auto-create a rule when you categorise by
hand, so each new recurring merchant needs a rule adding. Pre-stage `imported_payee contains`
rules are what catch the card rows, since the payee text arrives from the bank rather than from
Actual's own matcher.

**A new unparsed format.** The run exits non-zero with `UNPARSED <message-id>`. The subject is deliberately not printed: this stderr is what the alert's reason line is derived from, and a bank alert subject carries the amount and often the merchant. **The id is kept in `runs/unparsed.log`**, timestamped, so start there rather than from the alert: `reason=` only records the class (`matched no parser`), and cron discards the stderr the id was printed on. That file exists only once something has failed to parse, and it is written even when the streak gate held the alert. Then harvest the
message, add or extend a parser under `src/parsers/`, add a redacted fixture, extend the tests.
Fixtures are redacted `.txt` rather than raw `.eml` so redaction is grep-verifiable. Full
walkthrough in [WRITING-A-PARSER](WRITING-A-PARSER.md).

## Known failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Run aborts on start, no alert | `config.env` missing. The webhook lives in it, so nothing can speak | Restore `config.env`. This is the watchdog's irreducible gap and needs an off-host checker to close properly |
| Decrypt or auth failure that reads like a wrong password | `node --env-file` truncates a value at an unquoted `#`; or a secrets manager re-quoted a value and the container took the quotes literally | Quote for `node --env-file`, do not quote for `docker --env-file`. `run.sh` refuses to start on a quoted value. Use `scripts/set-env-value.js` |
| Gmail App Password looks wrong but is right | Google displays it in a spaced 20-character form (`abcd efgh ijkl mnop`). The spaced form authenticates as-is, so a store holding one spelling and a rendered `.env` holding the other is cosmetic, not a fault | Verified 2026-08-03. Normalise whichever copy is inconsistent, do not rotate the secret |
| Run fails with a foreign row present | frankfurter.dev unreachable | Intended: it fails rather than importing a guessed number. Re-run when the service returns |
| Two runs overlap | Sweep and top-up collide | Already handled: `flock` on `.lock`, `timeout -k 30 600` per container leg. The skipped run still logs |
| Alert storm | Regression in the per-channel budget | One slot per channel, fingerprint over the fault only. See DECISIONS 2026-07-29 |
| `SOURCE FAILED wise: Wise unreachable after 4 attempts` | Your resolver returned EAI_AGAIN, or Wise is genuinely down | Nothing to do. Four attempts over ~7s already rode the blip out, the Trust rows in that run were still written, and the next hourly pass re-covers the window. Only investigate if it repeats across several runs |
| `SOURCE FAILED trust-sg: …` | IMAP unreachable, or refusing the App Password | Same shape: the Wise rows still landed. Since 2026-08-03 `connect()` also retries a transient code 4× over ~7s, so a blip should no longer reach this line. A credential failure is NOT retried and shows up on the first attempt. Check the App Password if it persists past one run |
| Wise returns `403` from your dev machine but works in production | The Wise API token is IP-allowlisted to the deployment's public address | Not a bug. The Wise adapter's unit tests cover the pure transform with no network, so live verification is the only thing that has to run from the allowlisted host |
| `reason=[load: ACTUAL_MAIL_DRY_RUN is set, nothing was written]`, exit 2, heartbeat down | `ACTUAL_MAIL_DRY_RUN=1` is in `config.env` | Remove it. It belongs on the command line only. Before this was caught, such a run extracted rows, exited 0 and beat the heartbeat UP while the budget received nothing indefinitely |
| `ABORT: <tool> is not installed`, exit 2, heartbeat down | One of `flock`, `curl`, `python3`, `md5sum`, `docker` is missing from the host | Install it. These five are preflighted because losing any of them takes the alert channel down with it, so the failure would otherwise be silent |
| `watchdog.sh` exits `2` | Either no webhook is configured, or `curl`/`python3` is missing, or the feed is stale AND the webhook rejected the alert | Check `run.log` for the watchdog's own `REJECTED` line to tell the last case from the first two. A `2` always means nobody was told |

## Why did a failing run not alert?

Since 2026-08-05 a `SOURCE FAILED <src>` has to happen on **three of that source's last six
runs** before it posts anything. A resolver blip takes one source down for a single run and
fixes itself, and 15 of the first 139 runs failed that way — a message every time, none of them
actionable, which is how a channel stops being read. (Measured on the maintainer's own deployment
between 2026-07-29 and 2026-08-05. `runs/run.log` is gitignored, so that figure is not one a
reader of this repo can reproduce.)

Silence is never implicit. A held run still logs `extract=1`, still exits non-zero, and its
`reason=` carries a `quiet[wise=1/3]` marker — failures in that source's window over the
threshold:

```
grep 'quiet\[' runs/run.log        # what was held, and how close it is to speaking
```

The window is per source, so two sources blipping on alternate runs never add up to one source's
outage. Every run moves the window, clean ones included, so a source that recovers ages its
failures out rather than having them wiped: **a source failing every other run still reaches the
threshold**, which a consecutive-run streak never would. Two things are deliberately **not**
gated: a `matched no parser` (a bank changed its email format — waiting fixes nothing and delays
the one fault that needs hands), and any failure the two patterns do not recognise. The gate
fails open, because an unknown error is not a known-transient one.

The sweep is a reporting window like any other, not an exemption. The threshold and the window
are `SOURCE_FAIL_ALERT_AFTER=3` and `SOURCE_FAIL_WINDOW=6` in `run.sh`, constants rather than
settings. Per-source state lives in `.fail-window-<src>`.

## Dated gotchas

- **2026-08-03** — `run.log` recorded THAT a stage failed and never which failure it was, so of
  the first 12 `extract=1` runs in 100 only the 3 whose alert messages were still to hand could
  be told apart afterwards. (Measured on the maintainer's own deployment; `runs/run.log` is
  gitignored, so that figure is not one a reader of this repo can reproduce.) The reason lived solely in the alert body, which is not kept. Now
  captured into `reason=[…]` at the point `$ERR` still holds that stage's stderr — Part 2 reuses
  the same file, which is exactly why the exit trap could never have recovered it. The fallback
  deliberately skips the `N row(s), M ignored` counting line: it is the FIRST line of every real
  stderr and names no fault, so a naive `head -1` would have recorded noise as the reason.
- **2026-08-03** — A first `git push` to a new remote can hang silently for minutes on Windows.
  The system gitconfig puts the **Git Credential Manager** first in the helper chain, and it
  pops an invisible GUI prompt that a non-interactive push waits on forever. The fix is an
  **empty** `credential.helper` entry in `.git/config` to reset the chain, then `store`.
  `git config --local --replace-all` does not do this, because it drops the empty reset. Use
  `--unset-all` then two `--add` calls, and check with
  `git config --show-origin --get-all credential.helper`.
- **2026-08-03** — Give the host a **read-only** deploy credential, not your push credential.
  The host is a deploy target and never needs to write, and reusing a push token there puts
  write access to your other repos on a box that also holds `.env`.
- **2026-07-29** — A one-off DNS EAI_AGAIN on the Wise call took down the **whole** extract as
  an unhandled rejection, discarding the Trust rows already parsed in that run, and `run.sh`
  labelled the alert "unparsed mail" — so the first thing investigated was a mail-format change
  that had not happened. Two fixes: `get()` in `wise.js` retries a *network* failure (never an
  HTTP status), and `cli.js` catches each source independently so one dead source costs its own
  rows only. **Read the alert body, not the label** on anything older than this.
- **2026-07-29** — `scripts/test-run-sh.sh` is **Linux only**, since it needs
  `flock`. It cannot run on a Windows dev box, so shell-level regressions are only caught on the
  host or in CI. Run it after any `run.sh` change.
- **2026-07-29** — A green test suite proved compatible with a completely undeliverable alert
  channel: the suite stubbed `curl` and asserted the alert was *attempted*, not *deliverable*.
  When adding a test here, assert the observable outcome.
- **2026-07-28** — An `.env.bak-*` was found at mode 0644 on a network-exported share. Now 0600.
  Check permissions after any manual `.env` surgery, and prefer not to leave backups on an
  exported path at all.

## The cron entries

Host-agnostic does not have to mean command-free. `<deploy-dir>` holds `run.sh`, `watchdog.sh`,
`.env`, `config.env` and `mapping.json` at the top level, with the repo clone in `src/`. Cron runs
the top-level copies, not the ones in the tree.

```cron
30 5    * * * cd <deploy-dir> && ACTUAL_MAIL_SWEEP=1 ./run.sh   >>runs/cron.log 2>&1
15 6-23 * * * cd <deploy-dir> && ACTUAL_MAIL_SWEEP=0 ./run.sh   >>runs/cron.log 2>&1
0  7    * * * cd <deploy-dir> && ./watchdog.sh                  >>runs/cron.log 2>&1
```

The cadence is passed in, never derived from the clock inside the script — the host and the
container do not have to agree about the local hour.

If you run **only** the daily sweep, raise `ACTUAL_MAIL_STALE_MIN` to about `1500`. The default of
90 minutes assumes the hourly top-up is also running, and a sweep-only deployment would otherwise
be declared dead every single time the watchdog fires.
