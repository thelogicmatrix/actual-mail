#!/bin/bash
# Self-check for run.sh's cadence logic. Stubs docker and curl on PATH and drives the real
# script, so what is under test is the shipped file rather than a copy of its reasoning.
#
# Linux only: run.sh needs flock, which Git Bash on Windows does not ship. Run it on the
# host that runs the job -- `bash scripts/test-run-sh.sh` -- which is also the honest place
# to test it.
set -u -o pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/run.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
STAMP="$(date +%F)"
FAILURES=0

check() {  # check <label> <expected> <actual>
  if [ "$2" = "$3" ]; then
    printf 'ok   %s\n' "$1"
  else
    printf 'FAIL %s\n       expected: %s\n       actual:   %s\n' "$1" "$2" "$3"
    FAILURES=$((FAILURES + 1))
  fi
}

mkdir -p "$T/home" "$T/bin"
cp "$SRC" "$T/home/run.sh"
: >"$T/home/.env"
printf 'ALERT_WEBHOOK_URL=http://127.0.0.1:9/stub\n' >"$T/home/config.env"
printf '{}\n' >"$T/home/mapping.json"

# The extract writes a row and exits FAKE_EXTRACT_RC; the loader leg is the one carrying
# --entrypoint. Both legs are reached through `timeout`, so this also proves that wrapper
# did not break the call.
cat >"$T/bin/docker" <<'STUB'
#!/bin/bash
# Every invocation's arguments, so a check can assert WHICH image tag was actually run. The
# ACTUAL_MAIL_IMAGE-from-config.env bug was invisible without this: the run succeeded, it just
# succeeded against the wrong tag, which on a real host is `Unable to find image` at 05:30.
[ -n "${DOCKERARGS:-}" ] && printf '%s\n' "$*" >>"$DOCKERARGS"
# The loader leg is the one carrying --entrypoint.
for a in "$@"; do [ "$a" = "--entrypoint" ] && {
  # FAKE_DRY is ACTUAL_MAIL_DRY_RUN=1 left behind in config.env: the loader does the whole run,
  # writes nothing, exits 0, and says so ONLY in this line. Without the knob the suite could only
  # ever drive a loader that wrote, which is how a config that silently writes nothing forever
  # stayed green through every check in this file.
  if [ -n "${FAKE_DRY:-}" ]; then
    printf 'dry run: %s row(s) would be written, nothing written\n' "${FAKE_IMPORTED:-2}" >&2
  else
    printf 'imported %s row(s), 0 already present\n' "${FAKE_IMPORTED:-2}" >&2
  fi
  exit "${FAKE_LOAD_RC:-0}"; }
done
[ -n "${FAKE_EMPTY:-}" ] || echo '{"id":"x","source":"trust","amount":"-1.00"}'
# Shaped like the real Part 1, and every part of that shape earned its place by hiding a bug:
#   - a VOLATILE count line, because hashing it made the alert budget collapse whenever a
#     transaction arrived, which is whenever the system is doing its job;
#   - a stable fault description, which is what dedup should actually key on;
#   - MULTI-LINE, because a single-line stub let a JSON payload bug ship green.
printf '%s row(s), 0 ignored\n' "${FAKE_ROWS:-9}" >&2
# FAKE_UNPARSED=0 drops both of the next two lines. A source outage on its own is the shape the
# real 2026-08-05 10:15 failure had — a count line, SOURCE FAILED, and no parser complaint
# anywhere — and without this knob every stub failure also looked like a bank redesign, which is
# the one thing the streak gate must never delay. Default keeps the old body, so every check
# written before this knob existed is driven by exactly the bytes it was written against.
if [ "${FAKE_UNPARSED:-1}" != "0" ]; then
printf 'UNPARSED <abc@example.com> a subject that never changes\n' >&2
# cli.js emits this summary line alongside the per-message UNPARSED lines, and run.sh's
# fail_reason keys on it. A stub that omitted it let the reason field look untested.
printf '1 message(s) matched no parser — a new format, or a redesign\n' >&2
fi
# The other, opposite reason Part 1 exits non-zero: a source it could not reach at all.
[ -z "${FAKE_SOURCE_FAILED:-}" ] || printf 'SOURCE FAILED %s: getaddrinfo EAI_AGAIN somewhere\n' "$FAKE_SOURCE_FAILED" >&2
printf 'Error: connect ETIMEDOUT\n    at TCPConnectWrap.afterConnect (net.js:1141:16)\n    at /app/src/load/load.js:88:31\n' >&2
exit "${FAKE_EXTRACT_RC:-0}"
STUB
cat >"$T/bin/curl" <<'STUB'
#!/bin/bash
# Keep the body, not just the fact of the call: asserting an alert was attempted says
# nothing about whether the recipient could accept it.
prev=""
sawurlenc=""
for a in "$@"; do
  [ "$prev" = "-d" ] && printf '%s\n' "$a" >>"$PAYLOADS"
  [ "$prev" = "--data-urlencode" ] && { printf '%s\n' "$a" >>"$PUSHES"; sawurlenc=1; }
  prev="$a"
done
# A heartbeat is not an alert. Counting them together would let one hide the other.
[ -n "$sawurlenc" ] || echo "alert" >>"$ALERTS"
# FAKE_HTTP is what a revoked webhook does: accepts the connection, answers 401, forever. The
# callers read this off stdout with -w '%{http_code}', so the stub does not have to honour the
# flag to be honest about the status line.
echo "${FAKE_HTTP:-204}"
exit 0
STUB
chmod +x "$T/bin/docker" "$T/bin/curl" "$T/home/run.sh"
export PATH="$T/bin:$PATH" ALERTS="$T/alerts.log" PAYLOADS="$T/payloads.log" PUSHES="$T/pushes.log" DOCKERARGS="$T/dockerargs.log"
: >"$ALERTS" ; : >"$PAYLOADS" ; : >"$PUSHES" ; : >"$DOCKERARGS"

run() { env "$@" "$T/home/run.sh" >/dev/null 2>&1; }

# A stub URL, not a real monitor: the curl stub keys on --data-urlencode, so what is under test is
# that run.sh decides up/down/silent correctly, never that a push landed.
HB=http://127.0.0.1:9/hb

# --- cadence picks the window and keeps the two archives apart -------------------------
run ACTUAL_MAIL_SWEEP=1
check "sweep writes the day's archive" "yes" \
      "$([ -f "$T/home/runs/$STAMP.jsonl" ] && echo yes || echo no)"
check "sweep logs a 7-day window" "1" \
      "$(grep -c 'mode=sweep window=7d' "$T/home/runs/run.log")"

SWEEP_BEFORE="$(cat "$T/home/runs/$STAMP.jsonl")"
run ACTUAL_MAIL_SWEEP=0
check "hourly writes beside the sweep, not over it" "yes" \
      "$([ -f "$T/home/runs/$STAMP.partial.jsonl" ] && echo yes || echo no)"
check "the sweep's archive is untouched by an hourly run" "$SWEEP_BEFORE" \
      "$(cat "$T/home/runs/$STAMP.jsonl")"
check "hourly logs a 1-day window" "1" \
      "$(grep -c 'mode=hourly window=1d' "$T/home/runs/run.log")"
check "an explicit window overrides the cadence default" "1" \
      "$(run ACTUAL_MAIL_SWEEP=0 ACTUAL_MAIL_WINDOW_DAYS=3; grep -c 'mode=hourly window=3d' "$T/home/runs/run.log")"

# --- the alert budget -------------------------------------------------------------------
: >"$ALERTS"
run ACTUAL_MAIL_SWEEP=0 FAKE_EXTRACT_RC=3
run ACTUAL_MAIL_SWEEP=0 FAKE_EXTRACT_RC=3
check "the same failure twice in an hour costs one alert" "1" "$(wc -l <"$ALERTS")"

run ACTUAL_MAIL_SWEEP=1 FAKE_EXTRACT_RC=3
check "the sweep speaks even when the hourly guard is holding" "2" "$(wc -l <"$ALERTS")"

run ACTUAL_MAIL_SWEEP=0 FAKE_EXTRACT_RC=4
check "a different failure is news within the hour" "3" "$(wc -l <"$ALERTS")"

run ACTUAL_MAIL_SWEEP=0
run ACTUAL_MAIL_SWEEP=0 FAKE_EXTRACT_RC=4
check "a clean run forgets, so a recurrence alerts again" "4" "$(wc -l <"$ALERTS")"

# --- the unparsed message survives the run that found it ---------------------------------
# One sighting on 2026-07-29 evaporated because run.log kept the exit code and the message-id
# went to a stderr cron discarded. These assert the RECORD, not the alert: the alert was never
# the broken half.
: >"$T/home/runs/unparsed.log"
run ACTUAL_MAIL_SWEEP=0 FAKE_EXTRACT_RC=1
check "the unparsed message-id is kept, not just the exit code" "1" \
      "$(grep -c 'UNPARSED <abc@example.com>' "$T/home/runs/unparsed.log")"
check "and it is timestamped, so it joins up with run.log" "1" \
      "$(grep -cE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[^ ]+ UNPARSED ' "$T/home/runs/unparsed.log")"

# A held alert is the case that most needs the record, so it is the case that gets checked.
: >"$T/home/runs/unparsed.log"
run ACTUAL_MAIL_SWEEP=0 FAKE_EXTRACT_RC=1 FAKE_SOURCE_FAILED=wise
check "a suppressed alert still leaves the message behind" "1" \
      "$(grep -c 'UNPARSED <abc@example.com>' "$T/home/runs/unparsed.log")"

# A source outage carries no parser complaint, and `reason=` already names the source. Writing an
# empty entry for it would make the log's presence stop meaning anything.
rm -f "$T/home/runs/unparsed.log"
run ACTUAL_MAIL_SWEEP=0 FAKE_EXTRACT_RC=1 FAKE_UNPARSED=0 FAKE_SOURCE_FAILED=trust-sg
check "a source outage alone writes no unparsed record at all" "no" \
      "$([ -f "$T/home/runs/unparsed.log" ] && echo yes || echo no)"

# The clean path must not create it either, or its existence stops being the signal.
rm -f "$T/home/runs/unparsed.log"
run ACTUAL_MAIL_SWEEP=0
check "a clean run leaves no unparsed record" "no" \
      "$([ -f "$T/home/runs/unparsed.log" ] && echo yes || echo no)"

# The budget spends on DELIVERY, not on the attempt. It used to stamp the slot before the curl, so
# a revoked webhook -- 401, forever -- cost one attempt and one REJECTED line, and every run after
# that matched the fingerprint and returned before curl. A failing feed, an unreachable channel,
# and after run 1 not a word about either.
: >"$ALERTS"
rm -f "$T/home"/.last-alert-* "$T/home"/.fail-window-*
LOG_BEFORE="$(wc -l <"$T/home/runs/run.log")"
run ACTUAL_MAIL_SWEEP=0 FAKE_EXTRACT_RC=3 FAKE_HTTP=401
run ACTUAL_MAIL_SWEEP=0 FAKE_EXTRACT_RC=3 FAKE_HTTP=401
check "a rejected alert is tried again rather than deduped into silence" "2" \
      "$(wc -l <"$ALERTS")"
check "and every rejection is recorded, not just the first" "2" \
      "$(tail -n +$((LOG_BEFORE + 1)) "$T/home/runs/run.log" | grep -c 'alert REJECTED http=401')"

# ...and the budget still holds once the channel is actually accepting, or the fix above just
# turned every standing failure back into one message an hour.
: >"$ALERTS"
run ACTUAL_MAIL_SWEEP=0 FAKE_EXTRACT_RC=3
run ACTUAL_MAIL_SWEEP=0 FAKE_EXTRACT_RC=3
check "an accepted alert still costs one message, not one per run" "1" "$(wc -l <"$ALERTS")"

# --- a source outage has to earn its alert, and an outage always does -------------------
# 15 of the first 139 production runs failed extract, and the ones anybody looked at were a
# resolver blip that fixed itself by the next run. Those cost a message each and taught the
# channel to be ignored. Three failures in the last six runs is the bar; everything below is what
# that bar has to survive without also silencing the faults that need hands.
quiet() { run ACTUAL_MAIL_SWEEP="${2:-0}" FAKE_EXTRACT_RC=1 FAKE_UNPARSED=0 FAKE_SOURCE_FAILED="$1"; }

: >"$ALERTS"
rm -f "$T/home"/.last-alert-* "$T/home"/.fail-window-*
quiet wise
check "one source blip says nothing" "0" "$(wc -l <"$ALERTS")"
check "but the run log still records the failure" "1" \
      "$(tail -1 "$T/home/runs/run.log" | grep -c 'extract=1')"
check "and names the streak, so silence is not mistaken for health" "1" \
      "$(tail -1 "$T/home/runs/run.log" | grep -cF 'quiet[wise=1/3]')"
quiet wise
check "two in a row still says nothing" "0" "$(wc -l <"$ALERTS")"
quiet wise
check "the third consecutive window alerts" "1" "$(wc -l <"$ALERTS")"

# Recovery has to move the record, or the gate only ever delays the first alert of the machine's
# life and every later blip is instant. Two counters got this wrong before the window did, and
# both were silent on a real outage rather than noisy on a blip -- the expensive direction.
# Reset-on-recovery never reached three CONSECUTIVE failures at a 2-in-3 outage: 0 alerts in 30
# runs. Decay-on-recovery fixed that ratio and left 1-in-2 wide open: the counter goes 1,0,1,0
# forever, so 40 runs with half the feed missing produced 0 alerts. Failures per window has no
# such blind ratio, so these drive the shapes each predecessor was mute on.
: >"$ALERTS"
rm -f "$T/home"/.last-alert-* "$T/home"/.fail-window-*
quiet wise
run ACTUAL_MAIL_SWEEP=0
quiet wise
check "a clean run between two failures is not yet an outage" "0" "$(wc -l <"$ALERTS")"
quiet wise
check "but three failures inside the window alert, clean run among them or not" "1" \
      "$(wc -l <"$ALERTS")"

# The exact duty cycle the decaying counter could never see: fail, clean, fail, clean, fail.
: >"$ALERTS"
rm -f "$T/home"/.last-alert-* "$T/home"/.fail-window-*
for _ in 1 2 3; do quiet wise; run ACTUAL_MAIL_SWEEP=0; done
check "a source failing every other run alerts instead of staying silent forever" "1" \
      "$(wc -l <"$ALERTS")"

# ...and the property the window must not lose in exchange: a genuine one-off, followed by a
# window's worth of clean runs, leaves no state and no alert.
: >"$ALERTS"
rm -f "$T/home"/.last-alert-* "$T/home"/.fail-window-*
quiet wise
for _ in 1 2 3 4 5 6; do run ACTUAL_MAIL_SWEEP=0; done
check "a source that recovered and stayed recovered is forgotten entirely" "no" \
      "$([ -e "$T/home/.fail-window-wise" ] && echo yes || echo no)"
quiet wise
check "so its next blip starts from scratch and says nothing" "0" "$(wc -l <"$ALERTS")"

# Two sources failing on alternate runs is two independent blips, not a three-run outage. The
# per-source files make that true; a single shared counter would have alerted on the third run.
: >"$ALERTS"
rm -f "$T/home"/.last-alert-* "$T/home"/.fail-window-*
quiet wise
quiet trust-sg
quiet wise
check "alternating sources never add up to one source's outage" "0" "$(wc -l <"$ALERTS")"

# The gate is for the fault that fixes itself. A bank changing its email format does not, and
# delaying it three hours is the opposite of the point.
: >"$ALERTS"
rm -f "$T/home"/.last-alert-* "$T/home"/.fail-window-*
run ACTUAL_MAIL_SWEEP=0 FAKE_EXTRACT_RC=1
check "a parser break still alerts on the first run" "1" "$(wc -l <"$ALERTS")"

: >"$ALERTS"
rm -f "$T/home"/.last-alert-* "$T/home"/.fail-window-*
quiet wise 1
check "the sweep is a reporting window too, not an exemption from the count" "0" \
      "$(wc -l <"$ALERTS")"

# --- the budget has to survive the two ways it actually collapses -----------------------
# Both of these shipped broken and both were invisible: the suite only ever ran with the
# loader succeeding and with a fixed error body.
: >"$ALERTS"
rm -f "$T/home"/.last-alert-*
for _ in 1 2 3; do run ACTUAL_MAIL_SWEEP=0 FAKE_EXTRACT_RC=3 FAKE_LOAD_RC=5; done
check "a standing failure at BOTH stages costs two alerts once, not two an hour" "2" \
      "$(wc -l <"$ALERTS")"

: >"$ALERTS"
rm -f "$T/home"/.last-alert-*
for n in 9 10 11 12; do run ACTUAL_MAIL_SWEEP=0 FAKE_EXTRACT_RC=3 FAKE_ROWS=$n; done
check "a new transaction arriving does not re-trigger a standing alert" "1" \
      "$(wc -l <"$ALERTS")"

: >"$ALERTS"
rm -f "$T/home"/.last-alert-*
run ACTUAL_MAIL_SWEEP=1 FAKE_LOAD_RC=5
RC_LOAD=$?
check "a load failure alerts" "1" "$(wc -l <"$ALERTS")"
check "and exits with the loader's code" "5" "$RC_LOAD"
check "and records it in the run log" "1" "$(tail -1 "$T/home/runs/run.log" | grep -c 'load=5')"

# --- did anything actually get written? -------------------------------------------------
run ACTUAL_MAIL_SWEEP=1 FAKE_IMPORTED=7
check "the loader's counts reach the run log, not just its exit code" "1" \
      "$(tail -1 "$T/home/runs/run.log" | grep -c 'counts=\[imported 7 row(s)')"

# A loader that exits 0 has not necessarily written anything. ACTUAL_MAIL_DRY_RUN=1 is one line in
# the file the README tells you to copy, and left in it stops every write forever while extract=0,
# load=0 and a green heartbeat all say the feed is healthy. Every instrument agreed; the budget
# received nothing. `counts=` was the tell and it is absent, which is why the loader's own line is
# read rather than the absence of an `imported` one.
: >"$ALERTS" ; : >"$PUSHES"
rm -f "$T/home"/.last-alert-*
run ACTUAL_MAIL_SWEEP=1 HEARTBEAT_URL="$HB" FAKE_DRY=1
RC_DRY=$?
check "a dry-run loader fails the run rather than reporting a healthy one" "1" \
      "$(wc -l <"$ALERTS")"
check "and does not exit 0" "2" "$RC_DRY"
check "and beats the heartbeat DOWN" "down" \
      "$(grep -oE 'status=(up|down)' "$PUSHES" | head -1 | cut -d= -f2)"
check "and the run log names the setting, not just a failure" "1" \
      "$(tail -1 "$T/home/runs/run.log" | grep -c 'reason=\[load: ACTUAL_MAIL_DRY_RUN is set')"
check "and claims no counts, because nothing was imported" "0" \
      "$(tail -1 "$T/home/runs/run.log" | grep -c 'counts=')"

# --- run.log has to say WHICH failure, not just that one happened -----------------------
# Twelve extract failures in the first 100 runs were one indistinguishable line; only the 3
# whose Discord alerts were still to hand could be told apart after the fact.
run ACTUAL_MAIL_SWEEP=1
check "a clean run carries no reason field at all" "0" \
      "$(tail -1 "$T/home/runs/run.log" | grep -c 'reason=')"

run ACTUAL_MAIL_SWEEP=1 FAKE_EXTRACT_RC=1
check "an unparsed-mail failure is named as one" "1" \
      "$(tail -1 "$T/home/runs/run.log" | grep -c 'reason=\[extract: matched no parser\]')"

run ACTUAL_MAIL_SWEEP=1 FAKE_EXTRACT_RC=1 FAKE_SOURCE_FAILED=wise
check "an unreachable source is named as one, and says which source" "1" \
      "$(tail -1 "$T/home/runs/run.log" | grep -c 'reason=\[extract: SOURCE FAILED wise;matched no parser\]')"

run ACTUAL_MAIL_SWEEP=1 FAKE_LOAD_RC=5
check "a load failure names the stage it failed at" "1" \
      "$(tail -1 "$T/home/runs/run.log" | grep -c 'reason=\[load: ')"

# The counting line is the FIRST line of every real stderr and names no fault, so a fallback
# that took head -1 would record "9 row(s) 0 ignored" as the reason. It must not.
check "the reason never falls back to the volatile counting line" "0" \
      "$(grep -c 'reason=\[[a-z]*: [0-9]* row(s)' "$T/home/runs/run.log")"

# One line per run stays one line: a reason carrying a newline or a comma would break every
# `grep`/`cut` over this log, and the real bodies are multi-line by nature.
check "the run log is still one line per run" "0" \
      "$(awk 'NF && !/^20[0-9][0-9]-/ {n++} END {print n+0}' "$T/home/runs/run.log")"

# --- a failed re-run must not destroy the day's record ----------------------------------
run ACTUAL_MAIL_SWEEP=1
ARCHIVE_BEFORE="$(cat "$T/home/runs/$STAMP.jsonl")"
run ACTUAL_MAIL_SWEEP=1 FAKE_EMPTY=1 FAKE_EXTRACT_RC=1
check "a re-run that produces nothing leaves the archive intact" "$ARCHIVE_BEFORE" \
      "$(cat "$T/home/runs/$STAMP.jsonl")"

# --- the alert has to be something Discord will actually accept -------------------------
# The bug this catches shipped and stayed invisible: a stack trace's newlines are illegal
# inside a JSON string, Discord answers 400, and `curl -s` swallows it. Counting alerts
# cannot see that. Parsing the body can.
: >"$PAYLOADS"
run ACTUAL_MAIL_SWEEP=1 FAKE_EXTRACT_RC=3
check "the alert body is valid JSON for a multi-line error" "ok" \
      "$(python3 -c 'import json,sys
for line in open(sys.argv[1]):
    json.loads(line)
print("ok")' "$PAYLOADS" 2>/dev/null || echo BROKEN)"
# The reason survives and the stack does not. The webhook is a third party that retains what it
# is sent, and the stderr this used to ship carried whatever the binaries and every library under
# them printed — account digits and pot names until the loader was fixed, and arbitrary stack
# contents in the general case. Asserting the absence is the half that matters: "the reason got
# through" would still pass if the whole trace went with it.
check "the named fault reaches the payload" "ok" \
      "$(python3 -c 'import json,sys
body = json.loads(open(sys.argv[1]).readline())["content"]
print("ok" if "matched no parser" in body else "LOST")' "$PAYLOADS" 2>/dev/null || echo BROKEN)"
# fail_reason prefers the structured fault over whatever else the stage printed, so the trailing
# stack in the stub is noise after the real answer. That is the point: the alert names the class,
# the host keeps the detail.
check "and the stack, host paths and the bank's own text do NOT" "ok" \
      "$(python3 -c 'import json,sys
body = json.loads(open(sys.argv[1]).readline())["content"]
leaked = [s for s in ("load.js:88", "net.js:1141", "/app/src", "TCPConnectWrap",
                      "abc@example.com", "a subject that never changes") if s in body]
print("ok" if not leaked else "LEAKED " + ",".join(leaked))' "$PAYLOADS" 2>/dev/null || echo BROKEN)"

# The label carries the tool's name to whoever is on the receiving end, so a stale one is a
# branding leak that stays invisible until a user gets an alert — no test, no suite and no
# reviewer sees it. Asserted here rather than trusted, in both scripts that post.
check "the alert names the tool, not its pre-1.0 name" "1" \
      "$(grep -cF '[ERROR] actual-mail ' "$PAYLOADS")"

# --- a broken config must not be the quietest failure in the system ---------------------
mv "$T/home/.env" "$T/home/.env.hidden"
: >"$ALERTS"
run ACTUAL_MAIL_SWEEP=1
check "a missing .env alerts rather than exiting quietly" "1" "$(wc -l <"$ALERTS")"
mv "$T/home/.env.hidden" "$T/home/.env"

printf 'IMAP_PASSWORD="quoted"\n' >>"$T/home/.env"
: >"$ALERTS"
run ACTUAL_MAIL_SWEEP=1
check "a vault-requoted value alerts rather than exiting quietly" "1" "$(wc -l <"$ALERTS")"
sed -i '/IMAP_PASSWORD/d' "$T/home/.env"

# --- overlap ----------------------------------------------------------------------------
LOG_BEFORE="$(wc -l <"$T/home/runs/run.log")"
flock -x "$T/home/.lock" -c 'sleep 2' &
HOLDER=$!
sleep 0.3
run ACTUAL_MAIL_SWEEP=0
RC=$?
wait $HOLDER
check "a run that collides with a live one exits clean" "0" "$RC"
check "and leaves a skipped line rather than silence" "1" \
      "$(tail -n +$((LOG_BEFORE + 1)) "$T/home/runs/run.log" | grep -c 'skipped')"

# --- the heartbeat ----------------------------------------------------------------------
: >"$PUSHES"
run ACTUAL_MAIL_SWEEP=1 HEARTBEAT_URL=$HB
check "a run that worked beats the heartbeat up" "1" "$(grep -c '^status=up$' "$PUSHES")"

: >"$PUSHES"
run ACTUAL_MAIL_SWEEP=1 HEARTBEAT_URL=$HB FAKE_LOAD_RC=5
check "a run that failed beats it down" "1" "$(grep -c '^status=down$' "$PUSHES")"

: >"$PUSHES"
mv "$T/home/.env" "$T/home/.env.hidden"
run ACTUAL_MAIL_SWEEP=1 HEARTBEAT_URL=$HB
check "a run that could not even start beats down, not silence" "1" \
      "$(grep -c '^status=down$' "$PUSHES")"
mv "$T/home/.env.hidden" "$T/home/.env"

: >"$PUSHES"
run ACTUAL_MAIL_SWEEP=1
check "no heartbeat URL configured means no heartbeat and no broken run" "0:0" \
      "$?:$(wc -l <"$PUSHES")"

# --- the dead-man's switch --------------------------------------------------------------
# The one failure run.sh structurally cannot report is not running at all, so this is the
# check that the thing watching for that actually fires.
cp "$(dirname "$SRC")/watchdog.sh" "$T/home/watchdog.sh"
chmod +x "$T/home/watchdog.sh"

# The watchdog keys on runs/.last-complete, which only log_run writes and only at the end of a
# run that got that far. It used to key on run.log, and run.log is appended to by every path in
# run.sh including the ones where nothing ran — so the check below for a fresh log with no
# completed run is the bug this sentinel exists to close, and it is the one that matters most.
: >"$ALERTS" ; : >"$PAYLOADS"
touch "$T/home/runs/.last-complete"
"$T/home/watchdog.sh" >/dev/null 2>&1
check "a feed that completed a run recently is left alone" "0:0" "$?:$(wc -l <"$ALERTS")"

touch -d '4 hours ago' "$T/home/runs/.last-complete"
"$T/home/watchdog.sh" >/dev/null 2>&1
check "a feed that stopped is reported" "1:1" "$?:$(wc -l <"$ALERTS")"
check "and the watchdog names the tool too" "1" \
      "$(grep -cF '[ERROR] actual-mail watchdog: ' "$PAYLOADS")"

# The regression that made the dead-man's switch useless: runs that bail out early — a skipped
# overlap, an ABORT on a missing flock, a rejected alert — all append to run.log. A deployment
# whose every run bailed in the first ten lines kept run.log perfectly fresh, and the watchdog
# reported healthy forever. A fresh run.log must NOT count as a completed run.
: >"$ALERTS"
touch "$T/home/runs/run.log"
touch -d '4 hours ago' "$T/home/runs/.last-complete"
"$T/home/watchdog.sh" >/dev/null 2>&1
check "a fresh run.log does NOT pass for a completed run" "1:1" "$?:$(wc -l <"$ALERTS")"

: >"$ALERTS"
mv "$T/home/runs/.last-complete" "$T/home/runs/.last-complete.away"
"$T/home/watchdog.sh" >/dev/null 2>&1
check "and no sentinel at all counts as stopped, not as healthy" "1:1" "$?:$(wc -l <"$ALERTS")"
mv "$T/home/runs/.last-complete.away" "$T/home/runs/.last-complete"

# And the sentinel has to actually be written by a real run, or the whole check is decorative.
rm -f "$T/home/runs/.last-complete"
run ACTUAL_MAIL_SWEEP=0
check "a completed run writes the sentinel" "yes" \
      "$([ -f "$T/home/runs/.last-complete" ] && echo yes || echo no)"

# --- nothing happening is a signal too --------------------------------------------------
# Everything above tests that a FAILURE is reported. These test the opposite class, which is the
# one that produced a green dashboard over a dead feed: a run where nothing went wrong and
# nothing happened either.

: >"$ALERTS" ; : >"$PUSHES" ; rm -f "$T/home"/.last-alert-* "$T/home"/.fail-window-*
run ACTUAL_MAIL_SWEEP=1 HEARTBEAT_URL="$HB" FAKE_EMPTY=1
check "a 7-day sweep that extracts nothing alerts" "1" "$(wc -l <"$ALERTS")"
check "and beats the heartbeat DOWN, not up" "down" \
      "$(grep -oE 'status=(up|down)' "$PUSHES" | head -1 | cut -d= -f2)"
check "and says so in the run log" "1" \
      "$(tail -1 "$T/home/runs/run.log" | grep -c 'sweep found no rows')"

: >"$ALERTS" ; : >"$PUSHES"
run ACTUAL_MAIL_SWEEP=0 HEARTBEAT_URL="$HB" FAKE_EMPTY=1
check "an hourly run finding nothing is ordinary and stays quiet" "0" "$(wc -l <"$ALERTS")"
check "and still beats up, because most hours have no transactions" "up" \
      "$(grep -oE 'status=(up|down)' "$PUSHES" | head -1 | cut -d= -f2)"

# --- config.env has to be readable before the settings it defines are used ---------------
# IMAGE, SWEEP and WINDOW_DAYS were expanded 160 lines above the `. config.env` that defines
# them, so the documented way to set the image tag silently did nothing and the run pulled the
# default. That is the `Unable to find image` at 05:30 three docs warn about, caused by the tool.
printf 'ALERT_WEBHOOK_URL=http://127.0.0.1:9/stub\nACTUAL_MAIL_IMAGE=tag-from-config\n' \
  >"$T/home/config.env"
: >"$DOCKERARGS"
run ACTUAL_MAIL_SWEEP=0
check "ACTUAL_MAIL_IMAGE set in config.env actually reaches docker" "yes" \
      "$(grep -q 'tag-from-config' "$DOCKERARGS" && echo yes || echo no)"
check "and the default tag is not used instead" "no" \
      "$(grep -qE '(^| )actual-mail( |$)' "$DOCKERARGS" && echo yes || echo no)"

# ...but the cadence is the caller's, and sourcing config.env used to overwrite it. An operator
# setting ACTUAL_MAIL_SWEEP=0 here turned the 05:30 sweep into a second hourly run -- which is
# exactly the state in which the sweep-empty guard, the ONLY detector for "nothing is reaching the
# mailbox search at all", can never fire. README and RUNBOOK both say the caller decides.
printf 'ALERT_WEBHOOK_URL=http://127.0.0.1:9/stub\nACTUAL_MAIL_SWEEP=0\nACTUAL_MAIL_WINDOW_DAYS=2\n' \
  >"$T/home/config.env"
run ACTUAL_MAIL_SWEEP=1
check "the caller's cadence beats config.env" "1" \
      "$(tail -1 "$T/home/runs/run.log" | grep -c 'mode=sweep')"
run ACTUAL_MAIL_SWEEP=1 ACTUAL_MAIL_WINDOW_DAYS=5
check "and the caller's window beats it too" "1" \
      "$(tail -1 "$T/home/runs/run.log" | grep -c 'window=5d')"
# Preferring the caller must not mean ignoring config.env: with no caller value it still decides.
run
check "config.env still sets both when the caller passes neither" "1" \
      "$(tail -1 "$T/home/runs/run.log" | grep -c 'mode=hourly window=2d')"
printf 'ALERT_WEBHOOK_URL=http://127.0.0.1:9/stub\n' >"$T/home/config.env"

# --- the tools the failure paths themselves depend on ------------------------------------
# alert() builds its payload with python3, fingerprints it with md5sum and posts it with curl,
# and only flock was ever preflighted. On a host without python3 the payload is empty, curl POSTs
# nothing, the webhook answers 400, and the one channel that reports failure fails silently --
# the same bug this project already fixed once, by switching TO python3.
#
# A PATH with only the stubs and a hand-picked set of real tools is the only way to exercise this,
# because the harness prepends to the real PATH and `command -v` would otherwise still find
# everything. run.sh needs dirname, date and mkdir before it reaches the preflight at all.
mkdir -p "$T/nopy"
for c in dirname date mkdir flock md5sum; do ln -sf "$(command -v "$c")" "$T/nopy/$c"; done

: >"$PUSHES"
run PATH="$T/bin:$T/nopy" HEARTBEAT_URL="$HB"
check "a missing python3 aborts loudly instead of posting an empty alert" "1" \
      "$(tail -1 "$T/home/runs/run.log" | grep -c 'ABORT: python3 is not installed')"
check "and beats the heartbeat down on the way out" "1" "$(grep -c '^status=down$' "$PUSHES")"

PATH="$T/bin:$T/nopy" "$T/home/watchdog.sh" >/dev/null 2>&1
check "and the watchdog refuses to run rather than posting nothing at all" "2" "$?"

# The watchdog's own alert has to be ACCEPTED, not merely attempted. Exit 1 is documented as
# "stale, and an alert was sent"; a revoked webhook made it mean "stale, and nobody was told",
# which is the failure of the thing that exists to catch failures.
: >"$ALERTS"
touch -d '4 hours ago' "$T/home/runs/.last-complete"
FAKE_HTTP=401 "$T/home/watchdog.sh" >/dev/null 2>&1
check "a watchdog alert the webhook rejected does not report itself as sent" "2" "$?"
check "and it still tried" "1" "$(wc -l <"$ALERTS")"

printf '\n%s\n' "$([ $FAILURES -eq 0 ] && echo 'all checks passed' || echo "$FAILURES check(s) failed")"
exit $((FAILURES > 0))

# --- a rehearsal must actually rehearse ---------------------------------------------------
# ACTUAL_MAIL_DRY_RUN is read by the loader INSIDE the container, and the container's whole
# environment comes from the two --env-file arguments. So the obvious `ACTUAL_MAIL_DRY_RUN=1
# ./run.sh` set it in the calling shell and nowhere the loader could see it, and did a real run
# against a live budget while the operator believed nothing was being written. The RUNBOOK tells
# you to run one cadence by hand before trusting cron, so this is the invocation that gets typed.
printf 'ALERT_WEBHOOK_URL=http://127.0.0.1:9/stub\n' >"$T/home/config.env"
: >"$DOCKERARGS"
run ACTUAL_MAIL_SWEEP=0 ACTUAL_MAIL_DRY_RUN=1
check "ACTUAL_MAIL_DRY_RUN set in the environment reaches the container" "yes" \
      "$(grep -q 'ACTUAL_MAIL_DRY_RUN=1' "$DOCKERARGS" && echo yes || echo no)"

# And it must not appear when unset, or every cron run would carry an empty value into the
# container for a variable the loader compares against the string '1'.
: >"$DOCKERARGS"
run ACTUAL_MAIL_SWEEP=0
check "and is absent when unset, so cron is unchanged" "no" \
      "$(grep -q 'ACTUAL_MAIL_DRY_RUN' "$DOCKERARGS" && echo yes || echo no)"
