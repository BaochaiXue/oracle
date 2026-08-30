# Session completion notifications

Oracle can raise a desktop notification when a session finishes so you don’t have to babysit long runs.

## Behavior

- **Default:** on, except when `CI` or `SSH_CONNECTION` is set (those environments suppress notifications). The notification still fires when there is no TTY.
- **Scope:** fires on successful completion only (errors keep quiet).
- **Content:** `Oracle🧿 finished – session <slug> · $<cost> · <chars> chars`. Cost only shows for API runs where token pricing is known. Character count uses the returned answer text length.
- **Sound:** off by default. Enable with `--notify-sound` or `ORACLE_NOTIFY_SOUND=1`.

## CLI flags / env

- `--notify` / `--no-notify` (defaults to on unless `CI`/`SSH_CONNECTION`).
- `--notify-sound` / `--no-notify-sound` (defaults off).
- Env toggles: `ORACLE_NOTIFY=on|off`, `ORACLE_NOTIFY_SOUND=on|off`.

## Desktop backends

Notifications are powered by a macOS-first helper plus [`toasted-notifier`](https://github.com/Aetherinox/node-toasted-notifier) as fallback:

- macOS: OracleNotifier.app (arm64, unsigned by default; optionally signed and
  notarized with explicitly supplied fork-owned credentials) first; falls back
  to Notification Center via terminal-notifier
- Linux: `notify-send`/libnotify
- Windows: native Toasts via ntfy-toast/SnoreToast

If the OS backend is missing, Oracle logs a one-line skip reason instead of failing the session.

macOS note: The bundled `terminal-notifier` can occasionally lose its execute bit after download. Oracle automatically re-chmods it on first failure; if it still can’t run, clear quarantine manually:

```bash
xattr -dr com.apple.quarantine \ \
  $(pnpm root)/toasted-notifier/vendor/mac.noindex/terminal-notifier.app
```

## Sound toggle

Keep sound off during automated or shared environments; enable it when you truly want an audible ping (e.g., `--notify-sound`).
