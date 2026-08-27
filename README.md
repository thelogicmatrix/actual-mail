# actual-mail

Turns your bank's transaction-alert emails into [Actual Budget](https://actualbudget.org)
transactions.

Two commands, one pipe. `actual-mail` reads your mailbox (and optionally the Wise API) and
writes normalised rows to stdout as csv or jsonl. `actual-mail-load` reads those rows on
stdin and writes them into Actual. The first half has no idea Actual exists, so the csv goes
into YNAB, Firefly III, Beancount or a spreadsheet just as happily.

## Does it work with my bank?

Probably not yet, and that is the honest answer rather than a disclaimer.

Bundled sources: **Trust Bank (Singapore)** and **UOB (Singapore)**, both via alert email;
**Wise**, via its API rather than email. Only the first two are *parsers* — Wise returns
structured data, so there is no mail to parse and no fixture to redact.

Every bank writes its own alert emails and changes them without notice, so nobody can promise
this works for an arbitrary bank. What it does promise:

- A parser only ships if a **redacted sample of that bank's real mail** is in this repo with a
  test asserting the row it produces. No bank is listed on trust.
- When a message matches no parser, the run **exits non-zero and tells you**. It never guesses
  and never silently skips. If your bank redesigns its emails, you find out on the next run
  rather than at reconciliation.

Writing a parser for your bank is about forty lines. See
[docs/WRITING-A-PARSER.md](docs/WRITING-A-PARSER.md).

## Why this exists

Actual's bank-sync providers cover New Zealand, the European Union, North America and Brazil.
None cover Asia-Pacific. Verified 2026-07-28:

| Route | Singapore coverage |
|---|---|
| Akahu / Enable Banking / GoCardless / SimpleFIN / Pluggy | none, no Asia-Pacific |
| Synci (2,900+ institutions, 32 countries) | zero Singapore banks |
| Lunch Flow / `lunchflow/actual-flow` | rides the same providers, same gap |
| Salt Edge | zero Singapore banks |
| SGFinDex | restricted to licensed institutions, and it serves balances rather than a transaction feed |

Scripting a bank login is not an option either: the local banks require a digital-token
approval per session, and defeating your own two-factor authentication is not a foundation for
a published tool. What is left is the one channel banks push without being asked, which is the
alert email.

The alternative most people fall back on, screenshotting the banking app and having a language
model read the numbers, fails *plausibly*. A misread digit becomes a confident wrong number
with nothing to signal it, and the damage surfaces weeks later as a balance that will not
reconcile. Everything here is built for **deterministic extraction that fails loudly** instead.

## Install

Prerequisites:

- **Node 20 or newer.**
- **An IMAP mailbox** holding the alert mail. For Gmail this needs an
  [App Password](https://support.google.com/accounts/answer/185833), never your account
  password.
- **A running Actual server**, if you want the load half. The extract half needs nothing but
  the mailbox.
- Only if you use `scripts/run.sh` to put it on a schedule: `bash`, `docker`, `flock`,
  `timeout`, `curl`, `md5sum`, `python3`, `mktemp`, `awk`, and a GNU `date` that accepts `-d`.
  The macOS system `date` does not. `run.sh` preflights `flock`, `curl`, `python3`, `md5sum`
  and `docker` at startup and aborts naming the missing one — those are the five whose absence
  would otherwise fail silently or take the alert channel down with it. The rest fail loudly on
  first use.

This is a GitHub project, not an npm package, so there is nothing to install from the
registry. Clone it:

```bash
git clone https://github.com/thelogicmatrix/actual-mail.git
cd actual-mail
npm install
```

Or install the two commands globally straight from the repo:

```bash
npm i -g github:thelogicmatrix/actual-mail
```

Or build the container, which is what the scheduled runner uses:

```bash
docker build -t actual-mail .
docker run --rm actual-mail --help
```

The tag matters. `scripts/run.sh` defaults its image to `actual-mail`, so building under
another name gives you `Unable to find image` at 05:30 rather than at build time. Build a
differently-named image on purpose and set `ACTUAL_MAIL_IMAGE` to match.

## Quickstart

From a clean checkout to a row you can read, ending in a dry run. Nothing here writes to your
budget.

**1. Turn the alerts on.** The feed is only as complete as your bank's alert settings. In the
bank's app, set the transaction-alert threshold to **$0.00**, or the lowest it allows, for
every account and card you want tracked. Anything under the threshold never generates mail and
so never reaches this tool.

**2. Fill in the config.**

```bash
cp .env.example .env                  # mailbox and Actual credentials
cp mapping.example.json mapping.json  # row account -> Actual account id
cp config.env.example config.env      # only needed for the scheduled runner, below
```

**3. Extract, and look at what came out.** No credentials for Actual are needed yet.

```bash
node --env-file=.env bin/actual-mail.js --source trust-sg --since 2026-07-01 > transactions.csv
```

Name your bank rather than taking the default. `--source all` includes Wise, and while an unset
`WISE_API_TOKEN` simply skips it, being explicit is how you find out that a source you *did*
configure is failing.

Two things produce exit 1 here *and still leave the rows that did parse in the file*. `UNPARSED
<message-id>` means a message matched no parser — that is the design, not a fault. `SOURCE FAILED
<id>: <reason>` means a whole source was unreachable. A rejected flag *value* also exits 1 but
writes nothing at all, and an unrecognised flag exits 2; see [Exit codes](#exit-codes).

**4. Now fill in the Actual half of `.env`.** Everything from here talks to your budget server,
including the dry run, so `ACTUAL_SERVER_URL`, `ACTUAL_PASSWORD`, `ACTUAL_BUDGET_PASSWORD` and
`ACTUAL_SYNC_ID` all have to be real. Both commands below refuse to start without them and name
the one that is missing.

**5. Find your Actual account ids** and put them in `mapping.json`:

```bash
node --env-file=.env scripts/list-accounts.js
```

**6. Dry run the load.** This talks to your Actual server and reads it, but writes nothing:

```bash
node --env-file=.env bin/actual-mail.js --source trust-sg --since 2026-07-01 --format jsonl \
  | ACTUAL_MAIL_DRY_RUN=1 ACTUAL_MAIL_MAPPING=./mapping.json \
    node --env-file=.env bin/actual-mail-load.js
```

Every row it would write is printed as a `DRY` line on stdout, and the already-present count is
real because the dry run goes through the same code against the same live account. Only the
write is stubbed. Those lines carry an amount and a payee, and go to stdout rather than stderr
deliberately: under `scripts/run.sh` the loader's stderr is what the alert's reason line is
derived from, and it is the first thing a future change might send outward wholesale.

**7. For a real import**, drop `ACTUAL_MAIL_DRY_RUN` and set
`ACTUAL_MAIL_RECONCILED_THROUGH` to the last date you reconciled. The loader refuses to run
without it, on purpose. See the configuration section below.

## Configuration

Every variable the code reads. The `.example` files between them declare only some of those, so
read this table rather than the examples.

> **Quoting depends on who reads the file.** `node --env-file` (local development) treats `#`
> as a comment **mid-value** and silently truncates a secret containing one, so **quote every
> value** in `.env`. `docker run --env-file` (the container) takes values **literally** and
> would keep your quotes as part of the secret, so **do not quote** in the files the container
> reads. Getting this backwards produces an error indistinguishable from a wrong password.
> `scripts/set-env-value.js` writes a correctly quoted local value without it ever appearing
> in a shell argument or your terminal history.

### Mailbox, read by `actual-mail`

| Variable | Example | What it is |
|---|---|---|
| `IMAP_HOST` | `imap.gmail.com` | Server holding the alert mail. |
| `IMAP_PORT` | `993` | Port. The connection is always TLS. |
| `IMAP_USER` | `you@example.com` | Mailbox login. |
| `IMAP_PASSWORD` | `abcd efgh ijkl mnop` | App Password, not your account password. |
| `IMAP_MAILBOX` | `INBOX` | Folder to search. Defaults to `INBOX`. |

### Wise, optional

| Variable | Example | What it is |
|---|---|---|
| `WISE_API_TOKEN` | `1a2b3c4d-...` | Personal API token. Leave it unset if you do not use Wise: `--source all` then skips Wise entirely. An explicit `--source wise` with no token still fails loudly, because there you have said you want it. |

Make the token in the Wise app under Settings, API tokens. A plain personal token in an
`Authorization: Bearer` header is enough for the balance-statement endpoint, so there is no
signing keypair and no second secret to store. Two things to expect: the token is restricted
to the addresses you allowlist, so calls from anywhere else return **403** and the run fails
loudly, and every currency balance you hold becomes its own row account named
`wise-<currency>`, so each one needs its own key in `mapping.json`.

### Actual, read by `actual-mail-load`

| Variable | Example | What it is |
|---|---|---|
| `ACTUAL_SERVER_URL` | `http://localhost:5006` | Your Actual server. From inside a container this must be the in-network address, not the one your browser uses. |
| `ACTUAL_PASSWORD` | | Server login. |
| `ACTUAL_BUDGET_PASSWORD` | | The budget file's own encryption password. |
| `ACTUAL_SYNC_ID` | | The budget's sync id, from Actual's settings under Advanced. |
| `ACTUAL_DATA_DIR` | `/app/.actual-cache` | Where Actual keeps its local cache. Defaults to `.actual-cache` beside the package, not beside your shell. |
| `ACTUAL_MAIL_MAPPING` | `./mapping.json` | Path to the account map. Required. |
| `ACTUAL_MAIL_RECONCILED_THROUGH` | `2026-07-26` | The reconciliation floor, `YYYY-MM-DD`. Required for a real import. |
| `ACTUAL_MAIL_DRY_RUN` | `1` | Set to `1` to print what would be written and write nothing. **Command line only — never put this in `config.env`.** A scheduled run whose loader reports a dry run is failed by `run.sh` and named in `reason=`, because otherwise it is a deployment that writes nothing while every instrument reads healthy. |

Actual needs **two** passwords when the budget file is end-to-end encrypted:
`ACTUAL_PASSWORD` for the server login and `ACTUAL_BUDGET_PASSWORD` for the file itself.
Supplying only the first authenticates fine and then fails at download, which reads like a
sync problem rather than a missing credential.

### Money

| Variable | Default | What it is |
|---|---|---|
| `BASE_CURRENCY` | `SGD` | The currency your Actual budget is denominated in. Anything else is foreign and takes the conversion path. |
| `FX_MARKUP` | `0.003` | Fraction added to the reference rate to approximate what the bank charges. A **fraction**, so `0.003` is 0.3% — `0.3` would mean 30%, and values above `0.1` are refused for that reason. Applied as a cost in both directions: a debit takes slightly more out than the mid-market rate, a refund puts slightly less back in. **Alert-derived rows only.** A Wise row arrives from the API after the conversion already happened at Wise's own rate, so it converts at mid with no markup — modelling a spread there would book a cost nobody was charged. |

**Set `BASE_CURRENCY` if your budget is not in Singapore dollars.** It decides which rows get
converted and which are taken at face value, so a wrong value quietly writes wrong amounts,
and it is the one setting a non-Singapore user has to get right. Rates are ECB reference rates
from [frankfurter.dev](https://frankfurter.dev), free and keyless. If the rate service is
unreachable, a run containing a foreign row fails rather than importing a guess.

### Scheduled runner, read by `scripts/run.sh` and `scripts/watchdog.sh`

| Variable | Default | What it is |
|---|---|---|
| `ACTUAL_MAIL_IMAGE` | `actual-mail` | Image tag to run. |
| `ACTUAL_MAIL_NETWORK` | `bridge` | Docker network to join, so the Actual server is reachable as a sibling container. |
| `ACTUAL_MAIL_SWEEP` | `1` | `1` is the daily sweep, `0` the hourly top-up. The caller decides: a value passed by the cron entry wins over one in `config.env`, which is only consulted when the caller passes neither. Same for `ACTUAL_MAIL_WINDOW_DAYS`. |
| `ACTUAL_MAIL_WINDOW_DAYS` | `7` sweep, `1` top-up | How far back to fetch. |
| `ACTUAL_MAIL_STALE_MIN` | `90` | How long the watchdog tolerates no **completed** run before calling the feed dead. It reads `runs/.last-complete`, which only a finished run writes — a run that bailed out early still appends to `run.log`, so log freshness is not evidence the feed ran. The default assumes hourly top-ups; a sweep-only deployment wants about `1500`. |
| `ALERT_WEBHOOK_URL` | | Failure alerts. Anything accepting a json post with a `content` field, which covers Discord and Slack-compatible webhooks. Empty disables it, and a clean run posts nothing either way. The message carries the **reason line only** — the class of fault, composed by `run.sh` — and never the raw stderr behind it, so diagnosis past that point means reading `runs/run.log` on the host. A webhook provider retains what it is sent indefinitely, and stderr is whatever this tool and every library under it happened to print. |
| `HEARTBEAT_URL` | | Push-style heartbeat, pinged on success. `status=up\|down` and `msg` are appended as query parameters, which is **Uptime Kuma's** convention. Unset means no heartbeat and never a failed run. |
| `HEARTBEAT_FAIL_URL` | | Where to ping on failure, for monitors that do not read `status`. **Healthchecks.io needs this** — it signals failure with a `/fail` URL suffix and ignores unknown query parameters, so without it a failing run pings the success endpoint and marks your check UP. Set it to `<your-url>/fail`. Cronitor uses `state=`. Unset, a failing run beats `HEARTBEAT_URL` with `status=down`. |

One more exists and is not part of running the tool: `FX_OBS` is read only by
`scripts/fx-calibrate.js`, a development script that measures the markup above against your own
past statements.

`config.env` (see `config.env.example`) holds the runner's settings, kept separate from `.env`
so bumping one date does not mean touching a secrets-managed file.

### `mapping.json`

Keys are the `account` values the parsers emit, and each maps to an Actual account id. A
missing key is a hard error rather than a skip, so the first run doubles as a completeness
check. It lists every missing key at once.

```json
{
  "card": "<actual account id>",
  "main": "<actual account id>",
  "0000": "<actual account id>",
  "wise-sgd": "<actual account id>",
  "pot:Buffer": "<actual account id>",
  "no-inbound-alert:0000": "<actual account id>"
}
```

Five shapes appear there, and `mapping.example.json` shows all of them: a named account a
parser chose (`card`, `main`), the last four digits of an account the alert email quoted, a
Wise currency balance (`wise-<currency>` in lower case), `pot:<Pot Name>` for a savings pot,
and `no-inbound-alert:<key>` described below.

`no-inbound-alert:<key>` records one measurement: **that bank sends you no alert when money
arrives.** Its value is the same account id `<key>` itself maps to.

An alert whose payee names one of your own accounts ("A/C ending 0000") describes both sides of
a transfer in one email, and this is what lets the far side be booked from it. That is only
safe where the receiving bank cannot send an alert of its own — otherwise its alert imports
beside the leg already created here and the money arrives twice. So the entry is a licence, and
you give it by checking: move a small amount in, and confirm nothing arrives from the receiving
bank while the sending bank's alert does. Without the entry, such a payee is just a payee.

A licence is a claim about a bank, and a row beats a claim. If the same run also holds a row that
pairs with this one, that row is the receiving bank contradicting the licence, and what happens
next depends on the budget. Where the pair is **refused** because one of its legs is already
imported, the licence is not applied either: the payee is left alone and the two rows import
separately, counted as a transfer left unlinked. Where neither leg is present the pair is simply
booked as a transfer — one transaction with the transfer payee, counted in `transfers` — so the
licence is bypassed there too, by the evidenced route rather than the claimed one.

`<key>` must be a **four-digit account key** in its own right, since four digits is the only
thing a payee can name. A `no-inbound-alert:<key>` with no matching `<key>` beside it, or over a
named key like `main`, is unreachable — the payee is resolved through the ordinary four-digit key
first — so the licence does nothing and transfers into that account quietly go back to being
ordinary spends. The loader warns when it finds one, counting them on stderr and naming them on
stdout, and imports anyway: an inert licence loses a link, not money.

Pot moves are written as **two-sided transfers** rather than spends. The row's payee becomes
the target account's transfer payee, so the money leaves one account and arrives in the other
instead of vanishing into a category.

### The reconciliation floor

`ACTUAL_MAIL_RECONCILED_THROUGH` (`YYYY-MM-DD`) is **required** for a real import. Rows dated
on or before it are skipped and counted.

It exists because reconciliation is a human action. Without it, a run backfills history you
have already balanced by hand, and since hand-entered transactions carry no import id, nothing
else would stop the duplicates. Bump it when you reconcile — to the last date you actually
reconciled, **yesterday at the newest**. The loader refuses a floor of today or later: rows are
skipped on `<=`, so a floor of today discards the rest of today permanently, and tomorrow's
sweep skips them again because the floor has not moved.

## The unparsed invariant

*Unparsed* means a message this tool fetched and could not turn into a row. Every fetched
message must do exactly one of three things:

1. match a transaction parser, or
2. match its parser's ignore list, which covers known non-transactional mail such as
   statements and marketing, or
3. be reported as `UNPARSED <message-id>` with a **non-zero exit code**. The subject is
   deliberately not printed: this stderr is what the alert's reason line is derived from, and a bank alert
   subject carries the amount and often the merchant.

There is no fourth outcome and no silent skip. Rows are written to stdout *before* the exit
code is set, so one unrecognised email never discards the batch that parsed correctly.

The rule extends to whole sources. Each parser and the Wise API are caught independently, so a
source that cannot be reached is reported as `SOURCE FAILED <id>: <reason>` and the other
sources' rows are still written. A transport failure on the Wise API is retried with a widening
delay; an HTTP status never is, because a 403 allowlist does not heal in a second.

The same refusal to guess runs through the load half. An unmapped account is an error rather
than a skip, a foreign row without a rate is an error rather than an estimate, and duplicate
detection is done on this tool's own deterministic import id rather than on Actual's fuzzy
importer, which matches on amount and payee within a date window and had silently dropped two
genuine same-amount spends as already-seen.

## Exit codes

`actual-mail` (extract):

| Code | Meaning |
|---|---|
| `0` | Every fetched message parsed or was ignored. |
| `1` | Either at least one message matched no parser or a source failed — rows that did parse are still on stdout — **or** a flag's *value* was rejected (`--source`, `--format`, `--since`), in which case nothing ran and nothing is written. |
| `2` | A flag was not recognised. The usage is printed and nothing is extracted. |

`actual-mail-load`:

| Code | Meaning |
|---|---|
| `0` | Rows imported, or stdin was empty and there was nothing to do. |
| `1` | Refused to start (`ACTUAL_MAIL_MAPPING` unset, floor missing or malformed, keys missing from `mapping.json`) or failed part way (unmapped account, no rate for a foreign row). |

`scripts/run.sh` exits `0` when a run is clean or was skipped because another was already
holding the lock, `2` when a precondition failed before either half started — a missing
prerequisite binary, or a loader that reported a dry run — and otherwise whatever the extract or
load half returned, including `124` if a container hit its ten-minute timeout.

`scripts/watchdog.sh` exits `0` when the feed is alive and `1` when it is stale and the alert was
**accepted**. It exits `2` whenever it could not deliver a verdict at all: no webhook configured,
a missing `curl` or `python3`, or a stale feed whose alert the webhook rejected. The distinction
that matters is `1` versus `2` — a `1` means someone was told, a `2` means nobody was.

## Running it on a schedule

`scripts/run.sh` is the driver. It runs the extract half, archives the rows under `runs/`,
pipes them into the load half, and posts to a webhook **only on failure**. Copy `run.sh` and
`watchdog.sh` to a deployment directory alongside `.env`, `config.env` and `mapping.json`, then add
the three cron entries from [the RUNBOOK](docs/RUNBOOK.md#the-cron-entries) — the actual crontab
lines are there rather than here. Plain `docker run`, not compose, so it
works on hosts that have no compose plugin.

Two cadences off one script, and the caller picks which, because the host and the container do
not have to agree about the local hour:

| | `ACTUAL_MAIL_SWEEP` | Window | Archive | Alerts |
|---|---|---|---|---|
| **Sweep**, once daily | `1` (default) | 7 days | `runs/YYYY-MM-DD.jsonl` | any fault the top-up held back, except a source outage |
| **Top-up**, hourly | `0` | 1 day | `runs/YYYY-MM-DD.partial.jsonl` | only a fault the last run did not already report |

The split exists because "alert on every failure" does not survive hourly execution. One
unparsed email sits inside the window and re-fires on every pass. So the top-up suppresses a
repeat of a fault it last reported, the sweep reports what the top-up held back, and a clean run
clears the memory. A standing failure costs one message a day, a new one arrives within the hour,
and nothing is dropped.

One fault is held on **both** cadences: a source that cannot be reached waits until it has failed
**three of its last six runs** before it posts anything, because a resolver blip fixes itself by
the next run and a message per blip is how a channel stops being read. A window rather than a
streak, because a streak counts only *consecutive* failures — a source failing every other run
never reaches three in a row, so a feed that is down half the time would stay silent forever. The
run still logs `extract=1`, still exits non-zero, and records `quiet[wise=1/3]` in its `reason=`
field — failures in the window over the threshold — so a held failure is visible in
`runs/run.log` rather than indistinguishable from health. An unparsed email is never held — a
bank changing its format does not fix itself. See [RUNBOOK](docs/RUNBOOK.md), "Why did a failing run
not alert?".

Because silence no longer proves health, every run appends a line to `runs/run.log`, including
runs skipped for overlapping and including the loader's own counts. `extract=0 load=0` on its
own cannot tell a healthy quiet day from a stale reconciliation floor discarding everything.

`run.log`'s `reason=` field names the **class** of fault, which for a bank redesign is the
constant `matched no parser`. The **instance** goes to `runs/unparsed.log`: the per-message
`UNPARSED <message-id> [note]` lines, timestamped so they join up with `run.log`. That file only
exists once something has failed to parse, so its presence is itself a signal, and a source outage
or a clean run never creates it. It is written before the streak gate decides whether to alert,
because a held alert is exactly when the record matters most.

It records the **message-id, not the subject** — `cli.js` never prints a subject, because a bank
alert's subject carries the amount and often the merchant. The id is enough to pull the message by
hand. Host-side either way: the webhook receives the curated reason line and never this.

`scripts/watchdog.sh` is the dead man's switch, on its own cron entry. Everything in `run.sh`
reports its own failures, which cannot cover the one failure where the job does not run at all:
a lost cron entry, a regenerated schedule, a missing `config.env`. It alerts if
`runs/.last-complete` has not moved in 90 minutes, once a day until fixed. It reads that
sentinel rather than `run.log` because a run that bailed out early still appends to the log, so
log freshness is not evidence the feed ran. Its irreducible limit is stated in the file:
if `config.env` is what went missing, neither script can alert, and closing that needs a
checker on another host.

## Your data

This repo is about your bank transactions, so the files it produces are as sensitive as your
bank statements.

- `runs/` holds the archived rows in plaintext: real merchants, real amounts, real accounts.
  `runs/unparsed.log` holds message-ids of mail no parser matched. No subjects and no amounts,
  deliberately, but a message-id still identifies a real message in your mailbox.
- `config.env` holds your webhook, and `.env` your mailbox and Actual passwords.
- `.actual-cache/` is a local copy of your budget.

All of them are gitignored. Before you commit anything, run the leak gate:

```bash
npm run scan
```

It reads every tracked file and names anything PII-shaped: email addresses, account endings,
merchant strings, identity numbers, phone numbers, private network addresses. It exits
non-zero whenever it has findings, so it is usable as a gate in a hook or in CI. It is not a
substitute for reading your own diff. It catches shapes, not everything.

## Known limitations

1. **Alert amounts are authorisations, not settled amounts.** Converted rows are estimates by
   construction, and a domestic row can still settle at a different figure if a hold changes.
   Every estimated row says so in its note. Monthly reconciliation is expected, not
   exceptional.
2. **Cross-source double counting, within one run only.** A transfer between two of your own
   accounts appears in both feeds. Legs that land in the **same** run are paired and written as
   one two-sided transfer. Legs that arrive in different runs — a source down for a run is
   enough — are counted and reported as a transfer left unlinked, and joining them up is yours to
   do: the loader never edits a transaction already in your budget. **Cross-currency transfers are
   not detected at all**, since the two legs are not equal and opposite.
3. **Fees and interest never alert**, so they never enter this feed at all.
4. **Conversion depends on an external rate service.** Unreachable means the run fails rather
   than importing an unconverted or guessed number.
5. **Deleting an imported transaction in Actual does not stick.** Dedup asks Actual which
   `imported_id`s it already holds, and Actual soft-deletes: a deleted row is excluded from that
   answer, so the next run imports it again. To correct a row, **edit it** — an edit keeps its
   `imported_id` and the row is recognised as already present. If you need it gone, delete it in
   Actual *and* raise `ACTUAL_MAIL_RECONCILED_THROUGH` past its date, or it will return.
6. **`scripts/run.sh` is the only entry point that takes a lock.** It holds `flock` on `.lock`
   for exactly this reason: dedup reads which rows exist and then writes, and two runs doing
   that at once can both decide the same row is new. Running `bin/actual-mail-load.js` by hand —
   as the Quickstart does — takes no lock, so do not do it while a scheduled run may fire. A
   batch is deduplicated against itself, so a doubled *input* is safe; two concurrent *writers*
   are not.

## Development

```bash
npm test        # the unit suite: offline, no credentials
npm run scan    # the leak gate
```

Fixtures are redacted `.txt` bodies rather than raw `.eml`, so redaction is grep-verifiable. A
merchant split across a quoted-printable line break cannot be grepped for. Quoted-printable
handling is covered in the mailbox tests instead.

`scripts/verify-scratch.js` builds a throwaway **local** budget, with no server and nothing
synced anywhere, imports your rows into it twice, and asserts that the second pass adds nothing
and that every pot move landed as a linked transfer. Run it before pointing the loader at a
budget you care about.

Contributions, and especially parsers for other banks, are welcome. Read
[CONTRIBUTING.md](CONTRIBUTING.md) and [docs/WRITING-A-PARSER.md](docs/WRITING-A-PARSER.md)
first. The one hard rule is that a parser ships with a redacted fixture and a test.

## Project docs

| Doc | What is in it |
|---|---|
| [BRIEF](docs/BRIEF.md) | what this is, why it exists, what is deliberately out of scope |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | module map, data flow, soft spots |
| [FEATURES](docs/FEATURES.md) | what is live, built, planned |
| [DECISIONS](docs/DECISIONS.md) | every major choice, why, and what was rejected |
| [RUNBOOK](docs/RUNBOOK.md) | deploy, verify, known failure modes |
| [BACKLOG](docs/BACKLOG.md) | open work, with raw drops in [backlog/INBOX](docs/backlog/INBOX.md) |
| [WRITING-A-PARSER](docs/WRITING-A-PARSER.md) | add your own bank |
| [CONTRIBUTING](CONTRIBUTING.md) | what a mergeable change looks like |

## License

[MIT](LICENSE).
