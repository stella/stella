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
- **Retention sweep.** Expired data for the loaded account is deleted on load
  and by an hourly sweep, whether or not the feature is currently enabled.
  Activity never automatically deletes another account's history.
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
  timestamps, durations, window titles, documents, paths or summaries, and its native modules never import
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
length-delimited organization id and user id; changing API origin does not
change ownership. Disconnecting closes
the gate and window, supersedes pending requests, flushes only the active
prefix, and unloads all readable account state. Relinking another account
starts with that account's own consent and history. Previous accounts' encrypted
files remain available when those accounts relink.

Retention uses day filenames even when keys or settings are unreadable. The
loaded account uses its configured retention. Other namespaces remain untouched
until explicit deletion: the open activity window shows only their aggregate
day count and a Delete action with confirmation. It never shows their dates,
identity or content, and counting and deleting need no key or decryption.
Explicit deletion removes inactive day files and interrupted-write remnants;
it preserves the current account and settings. Namespace identity changed before
release, so there is no migration or read of old unnamespaced stores.

An app exclusion asks whether to keep or delete its past segments. Both choices
prevent future sampling of the app. Day partitions are pinned when a segment
opens; a time-zone change closes that partition before opening another. Idle
prefixes are trimmed to the last input before stopping or persisting. Sampling
gaps and flush cadence use a monotonic clock; backward wall-clock corrections
suspend new intervals until they no longer overlap prior observations.

## Opt-in activity details

Recording starts with application names only. A separate, unchecked choice
allows window titles and open documents; switching it off immediately stops
new detail capture while existing details follow the account's retention and
explicit deletion. Per-app “Record app name only” keeps time attribution
without capturing that application's details. Excluding an app with deletion
also removes every stored title and document for that app.

On macOS, enabling details explicitly requests Accessibility permission.
Without permission the sampler records app names and the activity window
provides a quiet link to the Accessibility settings. Focused-window reads use
bounded AX messaging timeouts outside the manager lock. Documents must be
local file URLs, converted to paths. Windows reads bounded foreground captions
from other processes; it records no document paths. Window identity is checked
again after capture. Details strip controls and stop at 512 UTF-8 bytes on a
character boundary; old day files without details remain readable.

Browser captions cannot reliably prove a window is public: Chromium may omit
incognito markers. Safari, Chrome, Edge, Firefox, Brave and Arc therefore default to
application-only attribution. Each browser has a separate title opt-in with
this warning: private windows may be recorded too, so pause recording or exclude
the browser while browsing privately. Known private markers suppress details
before truncation even after browser consent. Browser URLs are never captured.

Titles and document filenames appear only in the activity window; the full
local path appears on hover. Proposed blocks group by document when present
and require at least three minutes of actual span. Shorter spans still appear
in the raw list and contribute to the day's active total. Explicit Copy summary
may include document filenames; draft time-entry narratives remain empty.
Titles, paths and documents never enter telemetry, logs or error reports.
Platform wrappers are listed with the feature's native modules so the same
network and fixed-code guards cover them.

The gated tray shows recording status and today's active hours. While recording,
its optional Now label uses a document filename or app name, never a window
title or full path. App-name-only preferences, browsers without title consent
and detected private windows suppress that label. Pause and Resume update the
same account-owned recording state. A local icon dot appears only while
recording; activity events and a thirty-second refresh keep the menu current.
Tray source is covered by the local-only network and fixed-code guards.
