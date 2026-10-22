#!/usr/bin/env bash
# Build the Phone-Use APK with the bare Android SDK tools (no Gradle).
#   ./build.sh                 debug-signed (a local key is created on first run)
#   KEYSTORE=… KEY_PASS=… ./build.sh   signed with your release key
# Needs: Android SDK (build-tools + a platform), JDK 11+. ANDROID_HOME defaults to ~/Android/Sdk.
set -euo pipefail
cd "$(dirname "$0")"
SDK=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}
[ -d "$SDK/build-tools" ] && [ -d "$SDK/platforms" ] || { echo "Install Android SDK build-tools and a platform in $SDK" >&2; exit 1; }
BT="$SDK/build-tools/${BUILD_TOOLS_VERSION:-$(ls "$SDK/build-tools" | sort -V | tail -1)}"
JAR="$SDK/platforms/${ANDROID_PLATFORM:-$(ls "$SDK/platforms" | sort -V | tail -1)}/android.jar"
[ -f "$JAR" ] && [ -x "$BT/aapt2" ] && [ -x "$BT/d8" ] || { echo "Selected Android platform or build-tools are missing" >&2; exit 1; }
rm -rf build && mkdir -p build/res build/gen build/classes build/dex
"$BT/aapt2" compile --dir res -o build/res/res.zip
"$BT/aapt2" link -o build/unsigned.apk -I "$JAR" --manifest AndroidManifest.xml --java build/gen build/res/res.zip --auto-add-overlay
mapfile -d '' sources < <(find src build/gen -name '*.java' -print0)
javac -source 11 -target 11 -nowarn -Xlint:-options -cp "$JAR" -d build/classes "${sources[@]}"
mapfile -d '' classes < <(find build/classes -name '*.class' -print0)
"$BT/d8" --min-api 24 --lib "$JAR" --output build/dex "${classes[@]}"
(cd build/dex && zip -q -u ../unsigned.apk classes.dex)
"$BT/zipalign" -f 4 build/unsigned.apk build/aligned.apk
if [ -n "${KEYSTORE:-}" ]; then
  alias_args=()
  if [ -n "${KEY_ALIAS:-}" ]; then alias_args=(--ks-key-alias "$KEY_ALIAS"); fi
  "$BT/apksigner" sign --ks "$KEYSTORE" "${alias_args[@]}" --ks-pass env:KEY_PASS --key-pass env:KEY_PASS --out build/phone-use.apk build/aligned.apk
else
  [ -f debug.keystore ] || keytool -genkeypair -keystore debug.keystore -storepass android -keypass android -alias debug \
    -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=phone-use debug" >/dev/null 2>&1
  "$BT/apksigner" sign --ks debug.keystore --ks-pass pass:android --key-pass pass:android --out build/phone-use.apk build/aligned.apk
fi
"$BT/apksigner" verify build/phone-use.apk
ls -la build/phone-use.apk
