# actual-mail — Brief

## What

Turns Singapore bank transaction-alert emails, plus the Wise API, into a normalised
transaction feed, and optionally loads that feed into Actual Budget. One package, two bins, with
a deliberate seam: Part 1 extracts and never converts currency, Part 2 loads and converts.

## Why

Nathan's Singapore transactions previously reached Actual by screenshotting the banking app
and having an LLM read the screen. That works most of the time, which is the problem: when it
fails, it fails *plausibly*. A misread digit becomes a confident wrong number with no signal
attached, and the damage surfaces weeks later as a balance that will not reconcile.

The whole project serves one sentence: **deterministic extraction that fails loudly.** Where a
design choice trades convenience for a louder failure, it takes the louder failure. That is
also why this is not merely "more automation": automation that failed quietly would be a
regression from the screenshot method rather than an improvement on it.

It has to be built rather than bought because the coverage gap was verified, not assumed.
Actual's sync providers cover NZ, the EU, North America and Brazil, none of them APAC; the
aggregators claiming thousands of institutions list zero SG banks; SGFinDex is closed to
individuals. Scripting a bank login is off the table, since all three local banks require a
digital-token approval per session and defeating your own 2FA is not a foundation for a tool
intended for public release. The alert email is the one channel the banks push without
authentication. Route-by-route table in the [README](../README.md).

## Status

Shipped and running unattended on the maintainer's own server since 2026-07-28, on two cadences
(05:30 sweep, hourly top-up 06:15-23:15) plus a 07:00 watchdog, with a push heartbeat making
health visible on whatever monitor you point it at. A unit suite (`node --test` from the repo
root, which already includes `test/load/`) and a 38-check shell suite over the real driver
script.

Being prepared for **public release**. The blocker that held it private is closed:
`scripts/redact.js` now takes its literal rules from a gitignored `private.local.json` instead of
a hardcoded table, and `scripts/scan-pii.js` gates the tree.

## Scope

In scope: alert-email extraction for the banks Nathan holds, the Wise API, loading into Actual,
and the operational shell around that (cadence, alerting, archive, watchdog, heartbeat).

Out of scope by decision, not omission: scripting bank logins; reconciliation as an automated
act (it stays a human action, and the floor date enforces that); any LLM in the extraction
path. Fees and interest never generate alerts at all, so they are structurally beyond this
feed's reach rather than merely unimplemented.

---

See also: [Architecture](ARCHITECTURE.md), [Features](FEATURES.md), [Decisions](DECISIONS.md)
