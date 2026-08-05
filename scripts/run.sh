#!/bin/bash
# The driver. Part 1 reads the mail and the Wise API, Part 2 loads the rows into Actual.
#
# Runs on two cadences off one script:
#   sweep  (ACTUAL_MAIL_SWEEP=1, the default) — 7-day window, reports what the top-up held. Once a day.
#   hourly (ACTUAL_MAIL_SWEEP=0)              — 1-day window, alerts only on something new.
# Which one is running is decided by the CALLER, never by reading the clock here: the host
# and the container do not have to agree about the local hour, and a job that changes
# behaviour based on a timezone is a bug that waits until November to show up.
#
# Deliberately plain `docker run`, not `docker compose` — the Unraid host this is written
# for has no compose plugin (`docker: unknown command: docker compose`, checked 2026-07-28).
#
# Install: copy this, .env, config.env and mapping.json into $HERE, build the image once
# with `docker build -t actual-mail /path/to/repo`, then cron this script.
#
# That tag is not decoration: it is the default IMAGE below, so building under any other name
# gives `docker run: Unable to find image` at 05:30 rather than at build time. Build a
# differently-named image on purpose and set ACTUAL_MAIL_IMAGE to match.
set -u -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNS="$HERE/runs"
STAMP="$(date +%F)"
mkdir -p "$RUNS" "$HERE/cache"

# config.env is sourced HERE, before anything reads a setting out of it. It used to be sourced
# 160 lines further down, after IMAGE, SWEEP and WINDOW_DAYS had already been expanded from the
# environment alone, so setting ACTUAL_MAIL_IMAGE in config.env -- the documented place to set it
# -- silently did nothing and the run pulled the default tag. That is exactly the `Unable to find
# image` at 05:30 that three of this project's own documents warn about, manufactured by the tool
# rather than by the operator.
#
# It stays first for the original reason too: the alert webhook lives in it, so every guard below
# has to be able to report its own failure. They used to exit before alert() existed, and cron
# discards stderr, so the likeliest failure in the system was also its quietest.
[ -f "$HERE/config.env" ] || { echo "missing $HERE/config.env" >&2; exit 2; }

# Sourcing first has ONE casualty, captured here and preferred afterwards: the cadence belongs to
# the caller, and `. config.env` overwrites the environment. So a stray
# ACTUAL_MAIL_SWEEP=0 in config.env silently outranked the cron line that passes it -- turning
# the 05:30 sweep into a second hourly run. That kills the sweep-empty guard below, which is the
# ONLY detector for "nothing is reaching the mailbox search at all", and it does it while every
# other instrument stays green. README and RUNBOOK both say the caller decides; now the code does.
# ACTUAL_MAIL_WINDOW_DAYS rides along for the same reason, smaller blast radius.
#
# ACTUAL_MAIL_IMAGE is deliberately NOT in this list: config.env is its documented home.
CALLER_SWEEP="${ACTUAL_MAIL_SWEEP:-}"
CALLER_WINDOW_DAYS="${ACTUAL_MAIL_WINDOW_DAYS:-}"

# shellcheck source=/dev/null
. "$HERE/config.env"

IMAGE="${ACTUAL_MAIL_IMAGE:-actual-mail}"
SWEEP="${CALLER_SWEEP:-${ACTUAL_MAIL_SWEEP:-1}}"
WINDOW_DAYS="${CALLER_WINDOW_DAYS:-${ACTUAL_MAIL_WINDOW_DAYS:-7}}"
[ "$SWEEP" = "1" ] || WINDOW_DAYS="${CALLER_WINDOW_DAYS:-${ACTUAL_MAIL_WINDOW_DAYS:-1}}"

# The sweep owns the day's archive. An hourly run writes beside it rather than over it:
# same-day truncation would leave a file named for a 7-day question holding one day of
# answer, and the archive exists precisely so "why did this row appear" stays answerable.
if [ "$SWEEP" = "1" ]; then OUT="$RUNS/$STAMP.jsonl"; else OUT="$RUNS/$STAMP.partial.jsonl"; fi

# Heartbeat to a push-style monitor, which is what makes the feed's health visible on a
# dashboard instead of only knowable by reading a log.
#
# Defined ABOVE the lock block so the aborts below can beat down. They used to exit before this
# existed, so a deployment that could not lock at all went dark on the dashboard as well as in
# the channel.
heartbeat() {   # heartbeat <up|down> <msg>
  local url="${HEARTBEAT_URL:-}"
  # `status=up|down` is UPTIME KUMA's convention and nothing else's. Healthchecks.io signals
  # failure with a `/fail` URL SUFFIX and ignores unknown query parameters, so a failing run was
  # posting to the plain success endpoint and marking the check UP -- strictly worse than sending
  # nothing, because a missed ping would at least have gone red. Cronitor uses `state=`.
  #
  # So the failure ping is its own URL. Set HEARTBEAT_FAIL_URL for anything that is not Kuma;
  # unset, a failing run beats the same URL with status=down, which is right for Kuma and is what
  # this deployment has always done.
  if [ "$1" = "down" ] && [ -n "${HEARTBEAT_FAIL_URL:-}" ]; then url="$HEARTBEAT_FAIL_URL"; fi
  [ -n "$url" ] || return 0
  # Best-effort and never fatal - a dead monitor must not fail a run that actually worked.
  #
  # `--get` with --data-urlencode, not a hand-built query string: a message containing a
  # space or an ampersand would otherwise mangle it, which is how the alert payload broke.
  curl -fsS -m 10 -o /dev/null \
    --get --data-urlencode "status=$1" --data-urlencode "msg=$2" \
    "$url" 2>/dev/null || true
}

# Runs overlap the moment one of them hangs, and two containers sharing $HERE/cache is two
# writers on one Actual data dir. Second one out the door does nothing, and says so rather
# than vanishing — a skipped run has to be distinguishable from a run that never fired.
# Two very different failures used to share the "skipped" branch, and only one is benign.
# `flock` missing from cron's PATH, or a .lock that cannot be opened, took the same path: exit 0,
# a log line blaming an overlap that never happened, and -- because the EXIT trap is installed
# further down -- no heartbeat at all, not even a failing one. The feed then ran zero times while
# every instrument reported fine, and the log line sent you hunting a stuck run that did not
# exist. An overlap is routine; not being able to lock is a broken deployment.
#
# flock was the only one checked, and it is not the only one whose absence ends the run in
# silence. alert() needs python3 to build the payload, md5sum to fingerprint it and curl to post
# it: with python3 missing, `payload` is empty, curl POSTs nothing, Discord answers 400 and the
# only trace is one run.log line. That is the same silent-alert-channel failure this file already
# fixed once BY SWITCHING TO python3 -- it fixed the escaping, imported a new dependency, and
# preflighted neither. docker is here because without it every stage fails as `command not found`
# rather than as the unfinished deployment it is.
for cmd in flock curl python3 md5sum docker; do
  command -v "$cmd" >/dev/null 2>&1 && continue
  printf '%s ABORT: %s is not installed (see the README prerequisites)\n' "$(date -Is)" "$cmd" >>"$RUNS/run.log"
  echo "$cmd is not installed" >&2
  heartbeat down "$cmd missing"
  exit 2
done
exec 9>"$HERE/.lock" || {
  printf '%s ABORT: cannot open %s/.lock for writing\n' "$(date -Is)" "$HERE" >>"$RUNS/run.log"
  echo "cannot open $HERE/.lock" >&2
  heartbeat down "cannot lock"
  exit 2
}
if ! flock -n 9; then
  printf '%s skipped: a run was already in progress\n' "$(date -Is)" >>"$RUNS/run.log"
  exit 0
fi

# After the lock, not before: a skipped run used to exit above this line and leak the temp
# file, one per collision, forever.
ERR="$(mktemp)"


# Every run leaves one line behind. Suppressed repeat alerts (below) mean silence no longer
# proves health, so "did the 14:30 run happen" needs an answer that is not an empty inbox.
#
# Exit codes alone were not enough. "extract=0 load=0" is also exactly what a stale
# reconciliation floor silently discarding a week of rows looks like, so the loader's own
# count line is carried into the log rather than left to evaporate into a discarded stderr.
#
# `reason=` exists for the same reason, one level up. The log recorded THAT a stage failed and
# never which failure it was, and the reason lived only in the alert body, which is not kept —
# so of the first 12 `extract=1` runs in 100, only the 3 whose Discord alerts were still to
# hand could be told apart afterwards. A DNS blip and a bank redesigning its emails are the
# same line in this log, and they want opposite responses.
log_run() {
  printf '%s mode=%s window=%sd extract=%s load=%s%s%s\n' \
    "$(date -Is)" "$([ "$SWEEP" = "1" ] && echo sweep || echo hourly)" \
    "$WINDOW_DAYS" "${EXTRACT_RC:-aborted}" "${LOAD_RC:-n/a}" \
    "${COUNTS:+ counts=[$COUNTS]}" "${REASON:+ reason=[$REASON]}" >>"$RUNS/run.log"
  # Beat only on a run that actually worked. An aborted start (missing .env, quoted value)
  # leaves EXTRACT_RC unset and must read as down, not as silence — the monitor turning red
  # is the visible half of the same signal the watchdog raises on the webhook.
  # A sweep that found nothing counts as down even though no stage failed. Nothing reaching the
  # mailbox search at all is the failure mode that produces a perfect-looking run, so it must not
  # be the one thing that beats up.
  # A dry run is the third way to reach the end of this script with two zeroes and nothing
  # written, and the only one where the loader itself reported success.
  if [ "${EXTRACT_RC:-}" = "0" ] && [ "${LOAD_RC:-0}" = "0" ] \
     && [ "${SWEEP_EMPTY:-0}" = "0" ] && [ "${DRY_RUN_HELD:-0}" = "0" ]; then
    heartbeat up "${COUNTS:-no rows in window}"
  elif [ "${DRY_RUN_HELD:-0}" = "1" ]; then
    heartbeat down "ACTUAL_MAIL_DRY_RUN=1, nothing written"
  elif [ "${SWEEP_EMPTY:-0}" = "1" ]; then
    heartbeat down "sweep found no rows in ${WINDOW_DAYS}d"
  else
    heartbeat down "extract=${EXTRACT_RC:-aborted} load=${LOAD_RC:-n/a}"
  fi
  # Only log_run touches the sentinel, and only at the very end of a run that got this far. The
  # watchdog reads THIS file rather than run.log, because run.log is also appended to by the
  # skipped and ABORT paths above -- so a deployment whose every run bailed out immediately kept
  # run.log fresh and the dead-man's switch never fired.
  : >"$RUNS/.last-complete"
  rm -f "$ERR"
}
COUNTS=""
REASON=""
STREAK_NOTE=""
SWEEP_EMPTY=0
DRY_RUN_HELD=0
PRODUCED=0
trap log_run EXIT

# How many of the last SOURCE_FAIL_WINDOW runs one source has to fail before its alert fires.
#
# A resolver blip takes a source down for a single run and fixes itself — 15 of the first 139
# runs failed extract that way, every one of them a message that needed no action, which is how
# a channel stops being read. Three failures in six runs is not weather.
#
# A RATE, over a fixed window, because the two counters that came before it were both the wrong
# shape and both bought their quiet from the same account. Reset-on-recovery meant a source
# failing two runs in three never reached three CONSECUTIVE failures: 20 failures across 30 runs,
# 0 alerts. Decay-on-recovery (subtract one per clean run) fixed exactly that ratio and left the
# next one open — at a 50% duty cycle the counter goes 1,0,1,0 forever, so 40 runs with half the
# feed missing produced 0 alerts, while 66% produced 17. A window has no such ratio: whatever the
# pattern, 3 failures in 6 runs is 3 failures in 6 runs.
#
# Constants and not ACTUAL_MAIL_* settings on purpose: this is a judgement about one notification
# channel's noise floor, not something a deployment varies, and every env name here costs a row in
# the README table and config.env.example.
SOURCE_FAIL_ALERT_AFTER=3
SOURCE_FAIL_WINDOW=6

# The one-line summary of why a stage failed, for run.log. Kept to the fault's shape and
# stripped of newlines and commas, because run.log is one line per run and stays greppable:
# `SOURCE FAILED <src>` and `matched no parser` are the two answers Part 1 actually gives, and
# they want opposite responses — one is the resolver, the other is a bank changing its emails.
#
# The fallback skips the counting lines, the same ones alert()'s fingerprint strips and for the
# same reason: "9 row(s), 0 ignored" is the FIRST line of every real stderr, it changes whenever
# the feed is busy, and it names no fault at all. A naive `head -1` records exactly that.
fail_reason() {   # fail_reason <errfile>
  local r
  # `[a-z0-9-]+` not `[a-z]+`: parser ids are hyphenated since the registry landed, and the old
  # class stopped at the hyphen, recording `trust-sg` as `trust`. This is a run.log concern
  # only — alert() reads the stderr file itself and never calls this, so both faults are still
  # alerted either way. But RUNBOOK's "Why did it fail?" sends you to grep `reason=`, and a
  # truncated id points at the wrong troubleshooting row. Once two banks share a prefix,
  # `sort -u` also folds their distinct faults into one reason and the log stops saying which
  # bank died.
  #
  # `LC_ALL=C` on the sort because collation is locale-dependent: C sorts uppercase first and
  # gives `SOURCE FAILED wise;matched no parser`, en_US.UTF-8 gives the reverse. The reason
  # field is grepped by RUNBOOK and asserted by scripts/test-run-sh.sh, so it has to be the
  # same bytes on the maintainer's host, on the Unraid host (LANG unset) and on a CI runner
  # (UTF-8 by default) — not three orderings of the same fault.
  r="$(grep -oE 'SOURCE FAILED [a-z0-9-]+|matched no parser' "$1" 2>/dev/null | LC_ALL=C sort -u | tr '\n' ';' | sed 's/;$//')"
  [ -n "$r" ] || r="$(grep -vE '^[0-9]+ (row|message)\(s\)' "$1" 2>/dev/null | head -1)"
  printf '%s' "$(printf '%s' "$r" | tr -d ',' | tr -s ' ' | cut -c1-120)"
}

# streak_gate <errfile> — 0 means alert now, 1 means stay quiet this run.
#
# Gates ONLY `SOURCE FAILED <src>`, the fault that comes and goes on its own. `matched no parser`
# is a bank changing its email format: holding it back fixes nothing and delays the one fault
# that actually needs hands. Anything the two patterns do not recognise alerts immediately too —
# an unknown error is not a known-transient one, and failing open is the only safe default for a
# gate whose job is to stay silent.
#
# The gate is a RATE over the last SOURCE_FAIL_WINDOW runs, not a streak: see the constants
# above for the two counters that came before it and the outage ratio each one stayed silent for.
#
# Suppression is written into run.log's `reason=`, never left implicit. Silence that cannot be
# distinguished from health is the failure this whole file keeps re-learning: `reason=` itself
# exists because a suppressed alert took its explanation with it.
# record_run <source> <0|1> -- push one run's outcome onto that source's window.
#
# The whole state is one string of 0s and 1s per source, newest on the right, trimmed to the last
# SOURCE_FAIL_WINDOW runs. Same file-per-source layout as the counter it replaces, for the same
# reason: Wise and Trust go down independently, and one shared record lets two unrelated single
# blips add up to an alert neither of them earned.
#
# An all-clean window is no state at all, so the file is removed: a source that recovered and
# stayed recovered leaves nothing behind to trip over months later.
record_run() {
  local f="$HERE/.fail-window-$1" w
  w="$(cat "$f" 2>/dev/null)$2"
  # Guarded rather than a bare `${w: -$SOURCE_FAIL_WINDOW}`: bash returns the EMPTY string, not
  # the whole value, when a negative offset is longer than what it is slicing. Every window
  # shorter than SOURCE_FAIL_WINDOW -- which is every window for the first five runs of an
  # outage -- was therefore wiped on write, and the gate was silent on everything.
  [ "${#w}" -le "$SOURCE_FAIL_WINDOW" ] || w="${w: -$SOURCE_FAIL_WINDOW}"
  case "$w" in *1*) printf '%s' "$w" >"$f" ;; *) rm -f "$f" ;; esac
}

# A clean run is an outcome, not an absence of one, and every source being tracked has to record
# it — otherwise the window only ever moves on runs that failed, which is a streak counter again.
record_clean_run() {
  local f
  for f in "$HERE"/.fail-window-*; do
    [ -e "$f" ] || continue
    record_run "${f##*/.fail-window-}" 0
  done
}

streak_gate() {   # streak_gate <errfile>
  local failed src n f w
  grep -q 'matched no parser' "$1" 2>/dev/null && return 0
  failed="$(grep -oE 'SOURCE FAILED [a-z0-9-]+' "$1" 2>/dev/null | awk '{print $3}' | LC_ALL=C sort -u)"
  [ -n "$failed" ] || return 0

  # A source that came back this run records a clean run in its own window. It is not exempt just
  # because some OTHER source failed: a window that stops moving is a window that never forgets.
  for f in "$HERE"/.fail-window-*; do
    [ -e "$f" ] || continue
    src="${f##*/.fail-window-}"
    printf '%s\n' "$failed" | grep -qxF "$src" || record_run "$src" 0
  done

  # Every failing source is recorded before anything returns. An early return on the first one to
  # reach the threshold would leave the others' windows un-updated, so a second source failing
  # alongside a loud one would never climb to three and would never be reported.
  STREAK_NOTE=""
  local due=1
  for src in $failed; do
    record_run "$src" 1
    w="$(cat "$HERE/.fail-window-$src" 2>/dev/null)"
    n="${w//0/}"; n="${#n}"
    STREAK_NOTE="${STREAK_NOTE:+$STREAK_NOTE }$src=$n/$SOURCE_FAIL_ALERT_AFTER"
    [ "$n" -ge "$SOURCE_FAIL_ALERT_AFTER" ] && due=0
  done
  return $due
}

# config.env holds ACTUAL_MAIL_RECONCILED_THROUGH and the alert webhook, and is hand-edited on
# each reconciliation. It is kept out of the vault-rendered .env so bumping one date needs no
# vault write. Sourced at the top of this file, before anything reads a setting from it.

# alert <channel> <label> <errfile>
#
# Failures only — a clean run posts nothing, matching the existing webhook convention.
#
# "Failures only" was enough at one run a day. It is not enough at 18: one unparsed email
# sits inside the window and re-fires on every pass until it ages out, which turns a single
# thing to fix into a hundred-odd notifications and teaches you to ignore the channel. So an
# hourly run reports only what the previous run did not already report, while the sweep repeats
# what the top-up held. A standing failure costs one message a day, a new one arrives within the
# hour, and nothing is dropped.
#
# This budget is about REPEATS. It is not the streak gate below, which is about a first failure of
# a kind that usually fixes itself, and which the sweep does NOT bypass.
#
# Two things had to be right for that to hold, and the first version got both wrong.
#
# CHANNEL. There is one slot per channel, not one slot overall. A run can fail at extract
# AND at load, and with a single slot each call overwrote the other's fingerprint, so
# neither ever matched next time: a standing double failure sent two messages every hour,
# worse than the behaviour this replaced.
#
# SIGNATURE, not body. The fingerprint is taken over the error's shape with the counting
# lines stripped out, because Part 1 writes "N row(s), M ignored" to stderr on every run and
# N changes every time a transaction lands. Hashing the raw body meant the fingerprint moved
# whenever the feed was active, which is exactly when you least want the noise.
#
# The payload is built by python3 rather than printf, and this is not style. A real error
# body is multi-line, a raw newline is not legal inside a JSON string, so Discord answered
# 400 and `curl -s` said nothing: the one channel that reports failure was itself failing
# silently, and had been since the webhook was wired. The old `tr -d` was a hand-rolled
# escaper that stripped quotes and backticks and left the newlines that actually break it.
# The status code is checked too, so a rejected alert is recorded instead of lost — and does not
# count against the repeat budget, because a failure nobody received has not been reported.
alert() {
  [ -n "${ALERT_WEBHOOK_URL:-}" ] || return 0
  local body signature fingerprint slot payload code
  # The BODY is the curated reason, never the raw stderr. This goes to a third party that retains
  # it indefinitely, and the stderr it used to carry was whatever the two binaries -- and every
  # library beneath them -- chose to print. That was account digits and pot names until the loader
  # was fixed at the source, and in the general case it is the contents of any uncaught stack
  # trace. Auditing every message a dependency might emit is not a property that stays true, so
  # the shape is inverted: only text this script composed itself leaves the host.
  #
  # The FINGERPRINT still reads the full stderr. It never leaves the box, so precision there is
  # free, and taking it from the curated line instead would fold two distinct faults with the same
  # reason into one budget slot.
  body="$(fail_reason "$3")"
  [ -n "$body" ] || body='no recognisable reason line'
  body="$body
(full output stays on the host, in runs/run.log and this run's stderr)"
  signature="$(grep -vE '^[0-9]+ (row|message)\(s\)' "$3" | tail -c 1200)"
  fingerprint="$(printf '%s %s' "$2" "$signature" | md5sum | cut -d' ' -f1)"
  slot="$HERE/.last-alert-$1"
  if [ "$SWEEP" != "1" ] && [ "$fingerprint" = "$(cat "$slot" 2>/dev/null)" ]; then
    return 0
  fi
  payload="$(python3 -c 'import json,sys; print(json.dumps({"content": "[ERROR] actual-mail %s\n```%s```" % (sys.argv[1], sys.argv[2])}))' "$2" "$body")"
  # -m 15. heartbeat() has always carried a timeout and this did not, so a webhook host that
  # accepts the connection and never answers hung the run indefinitely -- inside the flock and
  # before the trap fired, which then made every later run log "skipped" and, before the sentinel
  # landed, kept the watchdog quiet too.
  code="$(curl -s -m 15 -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
    -d "$payload" "$ALERT_WEBHOOK_URL")"
  # The slot is stamped HERE, on the way out of a delivery that was accepted, and not before the
  # curl. Stamping it first meant "reported" was recorded as soon as it was attempted: a revoked
  # webhook answers 401 forever, so run 1 stamped the slot, got 401 and wrote one REJECTED line,
  # and run 2 matched that fingerprint and returned before the curl. One line in run.log, then
  # permanent silence on a channel that was never delivering anything.
  case "$code" in
    2*) printf '%s' "$fingerprint" >"$slot" ;;
    *) printf '%s alert REJECTED http=%s label=%s\n' "$(date -Is)" "$code" "$2" >>"$RUNS/run.log" ;;
  esac
}

# A startup failure that alert() can still speak about. Everything below this point can
# report itself; everything above it (a missing or unreadable config.env) cannot, because
# that is where the webhook comes from.
die() {
  echo "$1" >&2
  printf '%s\n' "$1" >"$ERR"
  alert start "cannot start" "$ERR"
  exit 2
}

# NOTE: both files are read by `docker run --env-file`, whose parser takes values
# LITERALLY — do NOT quote them here. That is the opposite of the local dev .env, which is
# read by `node --env-file` and MUST be quoted. See README.
[ -f "$HERE/.env" ]         || die "missing $HERE/.env"
[ -f "$HERE/mapping.json" ] || die "missing $HERE/mapping.json"

# Refuse to run on quoted values rather than fail later as "invalid credentials".
# `docker run --env-file` takes values literally, so KEY="secret" makes the quotes part of
# the secret. The error that produces is indistinguishable from a wrong password, and the
# opposite rule applies to `node --env-file` — so this is worth catching here, loudly.
for f in "$HERE/.env" "$HERE/config.env"; do
  bad=$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=(".*"|'"'"'.*'"'"')$' "$f" | grep -oE '^[A-Za-z_][A-Za-z0-9_]*' | tr '\n' ' ')
  if [ -n "$bad" ]; then
    die "$f: remove the surrounding quotes from: $bad (docker --env-file keeps them as part of the value)"
  fi
done

docker_run() {
  # The Actual server is a sibling container; reaching it by name needs its network.
  # Its externally-facing URL is not routable from inside a container.
  #
  # 10 minutes is an order of magnitude above a normal run. It is here so a hung IMAP
  # socket or a stalled pull cannot sit on the lock and mute every run until the sweep.
  # timeout exits 124, which reads as a failure and alerts like one.
  # -k 30: plain `timeout` sends SIGTERM and then waits forever if the process ignores it, so a
  # wedged docker CLI held the lock indefinitely. SIGKILL 30s later bounds it.
  timeout -k 30 600 docker run --rm -i \
    --network "${ACTUAL_MAIL_NETWORK:-bridge}" \
    --env-file "$HERE/.env" --env-file "$HERE/config.env" \
    -e ACTUAL_MAIL_MAPPING=/app/mapping.json \
    -e ACTUAL_DATA_DIR=/app/.actual-cache \
    -v "$HERE/mapping.json:/app/mapping.json:ro" \
    -v "$HERE/cache:/app/.actual-cache" \
    "$@"
}

# --- Part 1: mail + Wise -> rows -------------------------------------------------------
# The sweep's 7-day window is generous against the reconciliation floor, which is what
# actually decides what gets written. The hourly window is 1 day because it only has to
# catch what landed since the last pass — anything it misses the sweep re-covers, so a
# failed hourly run costs latency and nothing else. Rows are archived before Part 2 sees
# them, so "why did this row appear" stays answerable after the fact.
#
# Written to a temp file and moved into place only if it produced something. Redirecting
# straight at $OUT truncated the archive before the command even ran, so a re-run that
# failed early (docker down, image missing) destroyed that day's only complete record of
# what was extracted — while the comment above claimed the archive was there to answer
# exactly that question afterwards.
TMPOUT="$(mktemp)"
docker_run "$IMAGE" --since "$(date -d "$WINDOW_DAYS days ago" +%F)" --format jsonl --source all \
  >"$TMPOUT" 2>"$ERR"
EXTRACT_RC=$?
# PRODUCED records whether THIS run extracted anything, which is not the same question as
# "does $OUT exist". $OUT is shared by every hourly run of the day, so a run that extracted
# nothing used to find the previous run's archive still sitting there, load it again, and copy
# that run's import counts into its own log line and heartbeat. The dedupe made the write
# harmless; the damage was to the one field that exists to tell a healthy run from one silently
# discarding everything.
PRODUCED=0
if [ -s "$TMPOUT" ]; then mv "$TMPOUT" "$OUT"; PRODUCED=1; else rm -f "$TMPOUT"; fi

# Part 1 writes its good rows before setting a non-zero code, so an unrecognised email
# must be shouted about WITHOUT discarding the batch that parsed correctly.
#
# The label deliberately does NOT say "unparsed mail". Part 1 exits non-zero for an
# unrecognised email OR for a source it could not reach at all (SOURCE FAILED), and calling
# every one of them a mail-format problem sent us hunting the wrong thing on 2026-07-29.
# The body below the label says which it was.
if [ $EXTRACT_RC -ne 0 ]; then
  # Captured here, where $ERR still holds Part 1's stderr. Part 2 reuses the same file, so by
  # the time the exit trap runs the reason is gone — which is precisely how it went unrecorded.
  REASON="extract: $(fail_reason "$ERR")"
  if streak_gate "$ERR"; then
    alert extract "extract exited $EXTRACT_RC (see below)" "$ERR"
  else
    # The run still failed and still says so here and in its exit code. Only the notification
    # waits, so a blip costs a log line instead of a message.
    REASON="$REASON quiet[$STREAK_NOTE]"
  fi
fi

if [ "$PRODUCED" -eq 0 ]; then
  echo "no rows extracted; nothing to load" >&2
  # A clean run forgets, even a clean run with nothing in it: on a quiet night the reset
  # would otherwise never fire and a resolved fault would stay suppressed until the sweep.
  [ $EXTRACT_RC -eq 0 ] && { rm -f "$HERE"/.last-alert-*; record_clean_run; }

  # A SWEEP that extracts nothing is an anomaly, not a state. The hourly top-up finding nothing
  # is ordinary -- most hours have no transactions -- but a 7-day window with zero rows means
  # either a genuinely dead week or, far more likely, that nothing is reaching the mailbox
  # search at all: the bank changed its sender address, a mail rule moved the alerts, or
  # IMAP_MAILBOX was renamed. None of those fail. Every one of them looks exactly like a quiet
  # week, logs a byte-identical line, and used to beat the heartbeat UP.
  #
  # This is the one place the tool watches for NOTHING HAPPENING rather than for something
  # going wrong, which is the whole class it was previously blind to.
  if [ "$SWEEP" = "1" ] && [ $EXTRACT_RC -eq 0 ]; then
    REASON="${REASON:+$REASON | }sweep found no rows in ${WINDOW_DAYS}d"
    printf 'a %s-day sweep extracted no rows at all.\n\nThat is either a genuinely empty period or the mail is no longer reaching the search: a changed sender address, a mail rule, or a renamed IMAP_MAILBOX. None of those fail on their own.\n' \
      "$WINDOW_DAYS" >"$ERR"
    alert sweep "sweep found nothing in ${WINDOW_DAYS} days" "$ERR"
    # A flag, not a direct heartbeat call: log_run owns the single beat per run, and beating down
    # here would be immediately overwritten by the trap's `up` on the way out.
    SWEEP_EMPTY=1
    # Not a non-zero exit: nothing is broken, and failing the run would make `extract=0` mean
    # two different things. The alert and the down-beat are the signal.
  fi
  exit $EXTRACT_RC
fi

# --- Part 2: rows -> Actual ------------------------------------------------------------
docker_run --entrypoint node "$IMAGE" /app/bin/actual-mail-load.js \
  <"$OUT" 2>"$ERR"
LOAD_RC=$?

if [ $LOAD_RC -ne 0 ]; then
  # Same blindness on this stage, so the same capture. An extract reason already set is kept:
  # a run can fail at both, and "which one" is the whole point of the field.
  REASON="${REASON:+$REASON | }load: $(fail_reason "$ERR")"
  alert load "load failed (rc=$LOAD_RC)" "$ERR"
  cat "$ERR" >&2
  exit $LOAD_RC
fi

cat "$ERR" >&2          # the loader reports its counts on stderr on success too

# A loader that exits 0 has not necessarily WRITTEN anything. ACTUAL_MAIL_DRY_RUN=1 prints
# `dry run: N row(s) would be written, nothing written` and exits clean, and that setting is one
# line in the file the README tells you to copy — so leaving it behind after a rehearsal stops
# every write while extract=0 load=0 and a green heartbeat say the feed is fine. It is the exact
# shape of the failure this script keeps re-learning: nothing broken, nothing happening, nothing
# said. The loader's own line is the only place that fact exists, so it is read here rather than
# inferred from a setting run.sh does not otherwise know about.
if grep -q '^dry run:' "$ERR"; then
  REASON="${REASON:+$REASON | }load: ACTUAL_MAIL_DRY_RUN is set, nothing was written"
  DRY_RUN_HELD=1
  alert load "ACTUAL_MAIL_DRY_RUN=1 is set — nothing is being written to the budget" "$ERR"
  # Non-zero, unlike the sweep-empty guard: that one reports a period with no transactions in it,
  # this one reports a deployment that is not doing its job at all.
  exit 2
fi

# Carried into run.log by the exit trap. "extract=0 load=0" alone cannot tell a healthy run
# apart from one where a stale reconciliation floor silently discarded everything.
COUNTS="$(grep -E '^imported ' "$ERR" | tail -1)"
# A clean run forgets the last failure on every channel, so the same error recurring next
# week is news again instead of a duplicate the hourly guard swallows.
[ $EXTRACT_RC -eq 0 ] && { rm -f "$HERE"/.last-alert-*; record_clean_run; }
exit $EXTRACT_RC
