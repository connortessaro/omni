#!/bin/zsh
#
# Asserts that capturing system audio does not announce itself in the menu bar.
#
# Omni's HUD is a content-protected non-activating panel precisely so it does not
# show up in screen shares. A capture backend that lights the macOS recording
# indicator gives that away, so this is a property worth gating rather than
# rechecking by eye whenever the backend changes.
#
# It caught a real regression: the ScreenCaptureKit backend this replaced added
# "Screen Recording and System Audio Recording are in use" to the menu bar for
# the entire duration of every capture, audio-only or not.
#
# Read through the accessibility API, deliberately not screenshots. The first
# attempt at this used `screencapture`, which is itself a screen-capture client
# and lights the indicator, so it measured its own observer effect and produced
# a false positive in the control condition.
#
# Requires: Accessibility permission for the terminal running this, and real
# playback is not needed (an idle tap still lights an indicator if it is going
# to). Run from the repo root:
#
#     npm run audio:indicator-probe
#
set -u

REPO=${0:a:h:h}
SAMPLES=5

items () {
  osascript -e 'tell application "System Events" to tell process "ControlCenter" to get description of every menu bar item of menu bar 1' 2>/dev/null
}

fail () { print -r -- "FAIL  $1"; exit 1; }

baseline=$(items)
if [[ -z "$baseline" ]]; then
  fail "could not read Control Center's menu bar. Grant Accessibility permission to this terminal."
fi
print -r -- "baseline: $baseline"

# The repo's own ignored integration test is the capture source, so this probes
# the shipped code path rather than a bespoke harness binary.
(
  for i in {1..8}; do
    cargo test --manifest-path "$REPO/src-tauri/Cargo.toml" \
      -- --ignored captures_the_live_system_mix >/dev/null 2>&1
  done
) &
capture_pid=$!

differences=0
for i in $(seq 1 $SAMPLES); do
  current=$(items)
  if [[ "$current" != "$baseline" ]]; then
    differences=$((differences + 1))
    print -r -- "DIFF at sample $i:"
    print -r -- "  expected: $baseline"
    print -r -- "  actual:   $current"
  else
    print -r -- "sample $i: unchanged"
  fi
  sleep 1.5
done

wait $capture_pid 2>/dev/null

after=$(items)
if [[ "$after" != "$baseline" ]]; then
  fail "the menu bar did not return to its baseline after capture stopped"
fi

if (( differences > 0 )); then
  fail "system audio capture added $differences menu-bar change(s); the backend is announcing itself"
fi

print -r -- ""
print -r -- "PASS  capturing system audio left the menu bar unchanged across $SAMPLES samples"
