#!/usr/bin/env bash
# Installs the Android SDK needed to build an APK from this repo.
# Verified working on: Ubuntu 24.04, OpenJDK 21, Gradle 8.14.3.
set -euo pipefail

SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/android-sdk}"
CMDLINE_TOOLS_URL="https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip"

# Pinned on purpose: these exact versions are known to produce a valid,
# signed APK. Bump them deliberately, never incidentally.
PLATFORM="platforms;android-36"
BUILD_TOOLS="build-tools;36.1.0"

if [ -x "$SDK_ROOT/build-tools/36.1.0/apksigner" ]; then
  echo "Android SDK already present at $SDK_ROOT"
  exit 0
fi

echo "Installing Android SDK into $SDK_ROOT"
mkdir -p "$SDK_ROOT/cmdline-tools"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL --retry 3 -o "$tmp/cmdline-tools.zip" "$CMDLINE_TOOLS_URL"
unzip -q -o "$tmp/cmdline-tools.zip" -d "$SDK_ROOT/cmdline-tools"
# The archive unpacks as cmdline-tools/; sdkmanager requires it at latest/.
[ -d "$SDK_ROOT/cmdline-tools/cmdline-tools" ] &&
  mv "$SDK_ROOT/cmdline-tools/cmdline-tools" "$SDK_ROOT/cmdline-tools/latest"

export ANDROID_HOME="$SDK_ROOT" ANDROID_SDK_ROOT="$SDK_ROOT"
sdkmanager="$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager"

yes | "$sdkmanager" --licenses >/dev/null 2>&1 || true
"$sdkmanager" "platform-tools" "$PLATFORM" "$BUILD_TOOLS"

# Gradle finds the SDK through local.properties, which is gitignored.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "sdk.dir=$SDK_ROOT" > "$repo_root/local.properties"

echo
echo "Done. SDK at $SDK_ROOT ($(du -sh "$SDK_ROOT" | cut -f1))"
echo "Wrote $repo_root/local.properties"
