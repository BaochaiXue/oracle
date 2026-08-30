# Oracle Notifier helper (macOS, arm64)

Builds a tiny helper app for macOS notifications with the Oracle icon. Fork
builds are unsigned by default and use the bundle ID
`io.github.indeliblevivi.oracle.notifier`.

## Build

```bash
cd vendor/oracle-notifier
# Optional: sign with a fork-owned identity.
export CODESIGN_ID="Developer ID Application: YOUR FORK IDENTITY"
# Optional: notarize that signed build with fork-owned credentials.
export APP_STORE_CONNECT_API_KEY_P8="$(cat AuthKey_XXXXXX.p8)" # with literal newlines or \n escaped
export APP_STORE_CONNECT_KEY_ID=XXXXXX
export APP_STORE_CONNECT_ISSUER_ID=YYYYYYYY-YYYY-YYYY-YYYY-YYYYYYYYYYYY
./build-notifier.sh
```

- Requires Xcode command line tools (`swiftc`). No signing identity is required
  for the default local build.
- Signing occurs only when `CODESIGN_ID` is explicitly supplied. If all
  `APP_STORE_CONNECT_*` variables are also supplied, the script notarizes and
  staples that signed build.
- Output: `OracleNotifier.app` (arm64 only), bundled with `OracleIcon.icns`.

## Usage

The CLI prefers this helper on macOS; if it fails or is missing, it falls back to toasted-notifier/terminal-notifier.

## Permissions

After first run, allow notifications for “Oracle Notifier” in System Settings → Notifications.
