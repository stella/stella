# Local-only data

Some desktop features keep data on the device: clipboard history and the
activity timeline. Activity recording never exports data automatically; its
Copy summary action explicitly publishes the selected summary to the system
clipboard at the user's request. They share one set of guardrails. A new
local-only feature follows every rule below and adds one entry to
`tests/local-only-features.ts`, which the guard tests iterate.

## Checklist

- **Own encryption key.** Each store has its own keychain account
  (`keychain::LocalDataKey`). Data is written as AES-256-GCM envelopes through
  `local_store::EncryptedJsonFile`, atomically and readable by the owner only.
  Bind each file to its purpose with associated data when a store has more
  than one file.
- **Deletion-only on a missing key.** `local_store::resolve_key` never mints a
  key while encrypted data exists without one; the store opens in a
  deletion-only state until the user deletes the data.
- **Debug builds stay in memory** unless the feature's
  `STELLA_ENABLE_DEBUG_*_PERSISTENCE` variable is set.
- **Retention sweep.** Expired data is deleted on load and by an hourly sweep,
  whether or not the feature is currently enabled.
- **Payload-free events.** Changes are announced with `emit(..., ())`; the
  window pulls data through commands that take the feature's `LocalCaller`
  (`local_window.rs`), which checks the window label and the app origin.
- **Single-window capability.** The feature's commands are granted only in
  its own capability file, for its own windows.
- **No network imports.** Feature modules and the shared machinery
  (`local_store`, `local_window`, `foreground_app`, `idle_time`,
  `feature_gate`) contain no HTTP client or socket code.
- **Nothing recorded rides along in telemetry.** The native side drops error
  details from local-only windows. A feature marked `fixedCodes` (the activity
  timeline) reports fixed error codes only: no app identifiers or names, no
  timestamps, durations or summaries, and its native modules never import
  telemetry. Local log lines carry error kinds, not recorded data.
- **Bundled pages only.** Windows are built through `app_window::builder`,
  which refuses navigation off the app origin; the CSP allows no remote
  sources.
- **The server flag only gates existence.** `feature_access` fetches the
  decision with the account key and writes it to `feature_gate`; it never
  reads feature data, and features never call it. No response field can
  cause data to be read, exported or uploaded: a decision only starts or
  stops the feature. Any failure turns the feature off; turning it off stops
  it and closes its window but leaves stored data to retention.

## Guards

- `tests/local-only-network-boundary.test.ts`: no network code in feature
  modules or shared machinery; the gate fetch never references feature data;
  `fixedCodes` features send no error details and import no telemetry.
- `tests/local-only-window-boundary.test.ts`: commands granted only to the
  feature's windows, every command takes the caller proof, and every caller
  type is listed.
- `tests/window-capabilities.test.ts`: each window's capability grants what
  its page invokes.

## Activity account ownership

Activity days, settings and welcome consent belong to the linked account.
The store directory and encryption keychain account use a SHA-256 digest of
length-delimited API origin, organization id and user id. Disconnecting closes
the gate and window, supersedes pending requests, flushes only the active
prefix, and unloads all readable account state. Relinking another account
starts with that account's own consent and history. Previous accounts' encrypted
files remain available when those accounts relink.

Retention uses day filenames even when keys or settings are unreadable. The
active account uses its configured retention; inactive namespaces and legacy
unnamespaced files use the longest supported retention (90 days) without
opening any other account's key or settings. Old unnamespaced stores are never
read into an account namespace.

An app exclusion asks whether to keep or delete its past segments. Both choices
prevent future sampling of the app. Day partitions are pinned when a segment
opens; a time-zone change closes that partition before opening another. Idle
prefixes are trimmed to the last input before stopping or persisting. Sampling
gaps and flush cadence use a monotonic clock; backward wall-clock corrections
suspend new intervals until they no longer overlap prior observations.
