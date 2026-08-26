#!/bin/zsh
# Builds the signed app and installs it over /Applications/Omni.app.
#
# The copy has to replace the bundle rather than merge into it: cp -R onto an
# existing .app leaves stale files from the previous build behind, and a leftover
# framework or resource breaks the seal that codesign verified at bundle time.
#
# Privacy grants survive because scripts/build-signed.sh reuses the same local
# certificate, so the designated requirement stays identical across rebuilds.
# If it ever changes, see scripts/reset-privacy-grants.sh.

set -euo pipefail

REPO_ROOT="${0:a:h:h}"
BUILT_APP="$REPO_ROOT/src-tauri/target/release/bundle/macos/Omni.app"
INSTALLED_APP="/Applications/Omni.app"

zsh "$REPO_ROOT/scripts/build-signed.sh" "$@"

if [[ ! -d "$BUILT_APP" ]]; then
  echo "Build finished but $BUILT_APP is missing." >&2
  exit 1
fi

if pgrep -f "$INSTALLED_APP/Contents/MacOS/omni" >/dev/null 2>&1; then
  echo "Quitting the running Omni before replacing it."
  osascript -e 'quit app "Omni"' 2>/dev/null || true
  pkill -f "$INSTALLED_APP/Contents/MacOS/omni" 2>/dev/null || true
fi

rm -rf "$INSTALLED_APP"
cp -R "$BUILT_APP" "$INSTALLED_APP"

codesign -v --strict "$INSTALLED_APP"

echo
echo "Installed $INSTALLED_APP"
codesign -d --requirements - "$INSTALLED_APP" 2>&1 | sed -n 's/^designated => /  /p'
