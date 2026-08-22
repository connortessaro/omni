#!/bin/zsh
# Builds the macOS app signed with the local identity, so privacy grants survive
# the rebuild. See scripts/create-signing-identity.sh for why that matters.
#
# The identity is passed through APPLE_SIGNING_IDENTITY rather than
# tauri.conf.json on purpose: that config is committed, and the release workflow
# builds on GitHub runners where this certificate does not exist. Putting it in
# the config would break every CI release build.

set -euo pipefail

CONFIG_DIR="$HOME/.config/omni"
ENV_FILE="$CONFIG_DIR/signing.env"
KEYCHAIN="$HOME/Library/Keychains/omni-signing.keychain-db"
REPO_ROOT="${0:a:h:h}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "No signing identity found. Run scripts/create-signing-identity.sh first." >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

# A reboot relocks the keychain; unlocking is idempotent otherwise.
security unlock-keychain -p "$OMNI_SIGNING_KEYCHAIN_PASSWORD" "$KEYCHAIN"

if ! security find-identity -p codesigning "$KEYCHAIN" | grep -q "$OMNI_SIGNING_IDENTITY"; then
  echo "Identity \"$OMNI_SIGNING_IDENTITY\" is not in $KEYCHAIN." >&2
  echo "Re-run scripts/create-signing-identity.sh." >&2
  exit 1
fi

export APPLE_SIGNING_IDENTITY="$OMNI_SIGNING_IDENTITY"
echo "Signing as: $APPLE_SIGNING_IDENTITY"

npm --prefix "$REPO_ROOT" run tauri -- build "$@"

APP="$REPO_ROOT/src-tauri/target/release/bundle/macos/Omni.app"
if [[ -d "$APP" ]]; then
  echo
  echo "Designated requirement (this is what a privacy grant attaches to):"
  codesign -d --requirements - "$APP" 2>&1 | sed -n 's/^designated => /  /p'
fi
