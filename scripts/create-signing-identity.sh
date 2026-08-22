#!/bin/zsh
# Creates the local code-signing identity that macOS privacy grants attach to.
#
# Why this exists.
#
# Tauri signs local builds ad-hoc by default, which produces no certificate.
# With no certificate the designated requirement is a bare cdhash:
#
#   designated => cdhash H"82342ee3..."
#
# TCC stores that requirement alongside the grant, and a cdhash changes on every
# rebuild. So after each build macOS still *lists* Omni under Privacy & Security
# with its toggle on, but the requirement no longer matches and the app is
# denied — and because a row already exists it never re-prompts either. Screen
# recording fails with "permission required" while the checkbox reads enabled.
#
# Signing with a stable certificate makes the requirement cert-based:
#
#   designated => identifier "com.connortessaro.omni" and certificate root = H"46221d02..."
#
# That holds across rebuilds, so a grant given once keeps working.
#
# The certificate is self-signed and deliberately not added to the trust store:
# codesign only needs the private key to sign, so this needs no sudo and no
# authorization prompt. Gatekeeper is not involved for a locally built app you
# run yourself.
#
# Everything lands in a dedicated keychain with a generated password, so the
# login keychain is untouched and no interactive unlock is ever needed. The
# identity and its password are written to ~/.config/omni (mode 600) and never
# to the repo.
#
# Run once per machine. Safe to re-run: it replaces the keychain in place, but
# note that a new certificate means a new requirement, so the privacy grants
# have to be given one more time (see scripts/reset-privacy-grants.sh).

set -euo pipefail

CN="Omni Local Signing"
CONFIG_DIR="$HOME/.config/omni"
KEYCHAIN="$HOME/Library/Keychains/omni-signing.keychain-db"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

umask 077
mkdir -p "$CONFIG_DIR"

password="$(openssl rand -hex 20)"

cat > "$WORK/codesign.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = $CN
O = Omni
[v3]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
EOF

openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "$WORK/signing.key" -out "$WORK/signing.crt" \
  -config "$WORK/codesign.cnf" 2>/dev/null

# -legacy matters: OpenSSL 3 defaults to a PBKDF/MAC combination that Apple's
# Security framework cannot read, and the import fails with "MAC verification
# failed" that reads like a wrong password.
openssl pkcs12 -export -legacy -out "$WORK/signing.p12" \
  -inkey "$WORK/signing.key" -in "$WORK/signing.crt" \
  -name "$CN" -passout "pass:$password" 2>/dev/null

cp "$WORK/signing.p12" "$CONFIG_DIR/omni-signing.p12"
# Quoted: the identity name contains spaces, and build-signed.sh sources this.
printf 'OMNI_SIGNING_IDENTITY="%s"\nOMNI_SIGNING_KEYCHAIN_PASSWORD="%s"\n' \
  "$CN" "$password" > "$CONFIG_DIR/signing.env"
chmod 600 "$CONFIG_DIR/omni-signing.p12" "$CONFIG_DIR/signing.env"

security delete-keychain "$KEYCHAIN" 2>/dev/null || true
security create-keychain -p "$password" "$KEYCHAIN"
security set-keychain-settings "$KEYCHAIN"   # no auto-lock, no timeout
security unlock-keychain -p "$password" "$KEYCHAIN"
security import "$CONFIG_DIR/omni-signing.p12" -k "$KEYCHAIN" -P "$password" \
  -T /usr/bin/codesign -A
security set-key-partition-list -S apple-tool:,apple:,codesign: -s \
  -k "$password" "$KEYCHAIN" >/dev/null 2>&1

# Append to the search list without discarding what is already there. Each
# entry has to be passed as its own argument, or the list is written as one
# malformed multi-line path.
#
# The loop variable is deliberately not named `path`: zsh ties `path` to `PATH`,
# so assigning a string to it empties PATH and every external command after this
# point silently becomes "command not found".
existing=()
while IFS= read -r entry; do
  [[ -n "$entry" && "$entry" != "$KEYCHAIN" ]] && existing+=("$entry")
done < <(security list-keychains | tr -d '"' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
security list-keychains -s "${existing[@]}" "$KEYCHAIN"

echo "Identity created:"
security find-identity -p codesigning "$KEYCHAIN" | grep "$CN" || true
echo
echo "Certificate is untrusted by design; codesign does not require trust."
echo "Build with: npm run tauri:build:signed"
