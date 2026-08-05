#!/bin/bash
# Dead-man's switch.
#
# Every other failure path in actual-mail reports itself. None of them can cover the failure
# where the job does not run at all — a lost cron entry, a `user.scripts` update that
# regenerates the schedule, a flash write that drops it, a `config.env` that vanished. The
# alerting lives inside the job that stopped, so noticing that has to be a different job on
# a different schedule. This is that job, and it deliberately shares no code with run.sh.
#
# It runs once a day, after the 05:30 sweep and the 06:15 top-up have both had their turn.
# If neither of them COMPLETED a run — the sentinel below, not run.log, which every abort path
# touches on its way out — nothing is running. One message a day until
# it is fixed, which is the right volume for a last-resort net: silent for years, then
# repeating rather than one-and-done, because a dead feed you were told about once and
# forgot is the failure this exists to prevent.
#
# IRREDUCIBLE LIMIT, stated rather than papered over: the webhook lives in config.env. If
# config.env is what went missing, run.sh cannot alert and neither can this. Closing that
# needs a checker off this host entirely.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$HERE/runs/run.log"

# config.env FIRST, before the settings it defines are expanded. ACTUAL_MAIL_STALE_MIN used to be
# read three lines above the source, so config.env -- the only config this script loads at all --
# could not set it by any documented means.
# shellcheck source=/dev/null
[ -f "$HERE/config.env" ] && . "$HERE/config.env"
STALE_MIN="${ACTUAL_MAIL_STALE_MIN:-90}"
[ -n "${ALERT_WEBHOOK_URL:-}" ] || { echo "watchdog: no webhook configured" >&2; exit 2; }

# The same preflight run.sh does, for the same reason and with more at stake: this script's ONLY
# output is one POST built by python3 and sent by curl. With python3 missing, `payload` is empty,
# curl posts nothing, the webhook answers 400 and the dead-man's switch is mute — a silent failure
# of the thing that exists to catch silent failures. Refusing to run at all is louder than that.
# There is no heartbeat to beat down here: a watchdog that beat one would be a second thing to
# monitor, so cron's own exit-code mail is the signal, matching the no-webhook abort above.
for cmd in curl python3; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "watchdog: $cmd is not installed" >&2; exit 2; }
done

# The sentinel, NOT run.log. run.log is appended to by every path in run.sh including the ones
# where nothing ran: a skipped overlap, an ABORT on a missing flock, a rejected alert. So a
# deployment whose every run bailed out in the first ten lines kept run.log perfectly fresh and
# this check -- the last-resort net, the one thing that catches "the job is not running" -- never
# fired. It verified that something touched a file, not that the feed completed a run.
#
# log_run writes .last-complete at the end of a run that reached the end. Nothing else touches it.
# A missing sentinel finds nothing and reads as stale, which is correct and is also what a
# first-ever run looks like: better one spurious alert on day one than a silent switch.
COMPLETE="$HERE/runs/.last-complete"
[ -n "$(find "$COMPLETE" -mmin -"$STALE_MIN" 2>/dev/null)" ] && exit 0

msg="no COMPLETED run in the last ${STALE_MIN} minutes — the feed is not running. Last run.log line: $(tail -1 "$LOG" 2>/dev/null || echo '(no run.log at all)')"
payload="$(python3 -c 'import json,sys; print(json.dumps({"content": "[ERROR] actual-mail watchdog: %s" % sys.argv[1]}))' "$msg")"
# -m 15, matching run.sh: a webhook host that accepts the connection and never answers would
# otherwise hang the watchdog indefinitely, which is a silent failure of the silence detector.
code="$(curl -s -m 15 -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  -d "$payload" "$ALERT_WEBHOOK_URL")"
# Asserting that an alert was ATTEMPTED rather than DELIVERED is the mistake this project already
# made once and fixed in run.sh, and never applied to the last-resort net: a revoked webhook
# answers 401 and `curl -s` says nothing, so the switch fired daily into a closed channel and
# exited 1 — "stale, and reported" — every time. Exit 1 now means the report landed; exit 2 means
# the feed is dead AND the channel is too, which is worse and must not read the same.
case "$code" in
  2*) exit 1 ;;
  *) echo "watchdog: alert REJECTED http=$code" >&2; exit 2 ;;
esac
