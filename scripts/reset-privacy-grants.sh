#!/bin/zsh
# Clears Omni's macOS privacy grants so the next launch prompts again.
#
# Needed when the signing identity changes (a fresh certificate, or a build that
# went out ad-hoc). A stale grant is worse than no grant: TCC keeps the row with
# auth_value=2, so System Settings draws the toggle as enabled, but the stored
# requirement no longer matches the binary. The app is denied and never
# re-prompted, which surfaces as "Screen Recording permission required" next to
# a checkbox that is already ticked.
#
# Inspect the stored rows without changing anything:
#   sqlite3 ~/Library/Application\ Support/com.apple.TCC/TCC.db \
#     "select service, auth_value, hex(csreq) from access where client like '%omni%';"
#
# The trailing 20 bytes of csreq are the cdhash or certificate hash the grant is
# pinned to; compare against `codesign -d --requirements - /Applications/Omni.app`.

set -euo pipefail

BUNDLE_ID="com.connortessaro.omni"

# ScreenCapture lives in the system TCC database and the rest in the user one,
# but tccutil routes each by name, so no sudo is needed for any of them.
SERVICES=(Microphone AudioCapture ScreenCapture Accessibility ListenEvent PostEvent)

if pgrep -f "/Applications/Omni.app/Contents/MacOS/omni" >/dev/null 2>&1; then
  echo "Quitting Omni first; a running app holds its grants open."
  osascript -e 'quit app "Omni"' 2>/dev/null || true
  pkill -f "/Applications/Omni.app/Contents/MacOS/omni" 2>/dev/null || true
fi

for service in "${SERVICES[@]}"; do
  if tccutil reset "$service" "$BUNDLE_ID" >/dev/null 2>&1; then
    printf '  %-14s cleared\n' "$service"
  else
    printf '  %-14s no grant to clear\n' "$service"
  fi
done

echo
echo "Relaunch Omni and accept the prompts. They will bind to the current"
echo "signature, so a signed rebuild keeps them."
