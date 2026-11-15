#!/usr/bin/env bash
# Wizardry's own Android signing key, made and kept on this machine.
#
#   scripts/android-signing.sh init          make the key and android/key.properties
#   scripts/android-signing.sh fingerprint   print the certificate's SHA-256 (public; safe to share)
#   scripts/android-signing.sh assetlinks    write public/.well-known/assetlinks.json for this key
#
# The key is what proves an update comes from you: Android refuses an update
# signed by any other key, and a lost key cannot be replaced. `init` asks for a
# password without showing it, never prints it, and writes two files that git
# ignores: the keystore (default ~/.wizardry/android-release.jks) and
# android/key.properties, which the release build reads. Back both up somewhere
# that is not this computer. Nothing here uploads anything.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROPS="$ROOT/android/key.properties"
KEYSTORE="${WIZARDRY_KEYSTORE:-$HOME/.wizardry/android-release.jks}"
ALIAS="${WIZARDRY_KEY_ALIAS:-wizardry}"
APP_ID="xyz.slothlee.wizardry"

die() { echo "android-signing: $*" >&2; exit 1; }
command -v keytool >/dev/null || die "keytool not found (it comes with a JDK)"

prop() { sed -n "s/^$1=//p" "$PROPS" | head -1; }

fingerprint() {
  [ -f "$PROPS" ] || die "no android/key.properties yet: run 'init' first"
  local store pass
  store="$(prop storeFile)"; pass="$(prop storePassword)"
  [ -f "$store" ] || die "the keystore named in android/key.properties is missing: $store"
  STOREPASS="$pass" keytool -list -v -keystore "$store" -alias "$(prop keyAlias)" -storepass:env STOREPASS 2>/dev/null \
    | sed -n 's/^[[:space:]]*SHA256: //p' | head -1
}

case "${1:-}" in
  init)
    [ ! -e "$PROPS" ] || die "android/key.properties already exists; not replacing a signing key"
    [ ! -e "$KEYSTORE" ] || die "$KEYSTORE already exists; not replacing a signing key"
    if [ -n "${WIZARDRY_KEYSTORE_PASSWORD:-}" ]; then
      pass="$WIZARDRY_KEYSTORE_PASSWORD"
    else
      read -r -s -p "New keystore password (12+ characters): " pass; echo
      read -r -s -p "Again: " again; echo
      [ "$pass" = "$again" ] || die "the two passwords differ"
    fi
    [ "${#pass}" -ge 12 ] || die "use at least 12 characters"
    case "$pass" in *$'\n'*|*\\*) die "the password cannot contain a backslash or a line break" ;; esac
    mkdir -p "$(dirname "$KEYSTORE")"
    chmod 700 "$(dirname "$KEYSTORE")"
    umask 077
    STOREPASS="$pass" keytool -genkeypair -keystore "$KEYSTORE" -storetype PKCS12 -alias "$ALIAS" \
      -keyalg RSA -keysize 4096 -validity 10950 -dname "CN=Wizardry" \
      -storepass:env STOREPASS -keypass:env STOREPASS >/dev/null 2>&1 || die "keytool could not make the key"
    printf 'storeFile=%s\nstorePassword=%s\nkeyAlias=%s\nkeyPassword=%s\n' "$KEYSTORE" "$pass" "$ALIAS" "$pass" > "$PROPS"
    chmod 600 "$PROPS" "$KEYSTORE"
    echo "Made the signing key."
    echo "  keystore:   $KEYSTORE"
    echo "  settings:   android/key.properties (holds the password; git ignores it)"
    echo "  SHA-256:    $(fingerprint)"
    echo "Back up both files off this computer. Without them no update can ever be installed over this app."
    ;;
  fingerprint)
    fingerprint
    ;;
  assetlinks)
    fp="$(fingerprint)"
    [ -n "$fp" ] || die "could not read the certificate fingerprint"
    cat > "$ROOT/public/.well-known/assetlinks.json" <<JSON
[
  {
    "relation": [
      "delegate_permission/common.handle_all_urls"
    ],
    "target": {
      "namespace": "android_app",
      "package_name": "$APP_ID",
      "sha256_cert_fingerprints": [
        "$fp"
      ]
    }
  }
]
JSON
    echo "Wrote public/.well-known/assetlinks.json for $APP_ID. Commit it and deploy the site."
    ;;
  *)
    sed -n '2,7p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
