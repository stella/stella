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
  deletion-only state. Activity distinguishes a definitely missing key from
  a transient keychain failure. Missing-key and corrupt-file erasure require
  separate confirmation of lost pending recovery. Incompatible activity files
  require an app update and are always preserved.
- **Debug builds stay in memory** unless the feature's
  `STELLA_ENABLE_DEBUG_*_PERSISTENCE` variable is set.
- **Retention sweep.** Expired data for the loaded account is deleted on load
  and by an hourly sweep, whether or not the feature is currently enabled.
  Activity preserves days with pending draft batches, unreadable days, and
  incompatible files.
  It never automatically deletes another account's history.
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

## Calls

While recording, the activity sampler also asks the system which apps capture
microphone input: CoreAudio's per-process objects on macOS 14 and later, the
microphone consent store on Windows. Only a catalog of call apps and browsers
counts (`activity_calls.rs`); a browser must hold the microphone for about
fifteen seconds. Call time is recorded as a call segment for that app, whatever
is in front and however long the user only listens, and it ends at the last
sample that saw the call. Audio is never read. Excluded apps stay unrecorded,
window titles follow the same detail opt-ins, and the user can turn call
detection off in Activity settings.

## Activity account ownership

Activity days, settings and welcome consent belong to the linked account.
The store directory and encryption keychain account use a SHA-256 digest of
length-delimited organization id and user id; changing API origin does not
change ownership. Disconnecting closes
the gate and window, supersedes pending requests, flushes only the active
prefix, and unloads all readable account state. Relinking another account
starts with that account's own consent and history. Previous accounts' encrypted
files remain available when those accounts relink.

The loaded account uses its configured retention after reading each day's
pending draft state. Pending days remain available for recovery beyond that
window; unreadable day files are preserved. Other namespaces remain untouched
until explicit deletion: the open activity window shows only their aggregate
day count and a Delete action with confirmation. It never shows their dates,
identity or content. Counting needs no key or decryption. Deletion reads each
inactive account's existing key and refuses the operation if a draft batch
remains unresolved or the keychain lookup fails, before removing any files.
Inactive history with missing keys or unreadable files requires a separate
confirmation that pending recovery may be lost; drafts may already exist.
The operation rechecks keys and readable pending batches before deletion, removes
missing-key account roots, and preserves the current account. Current-account
unreadable recovery removes only files that remain unreadable after a live recheck,
preserving readable history and pending batches. A transient read error never
authorizes erasure. When time billing is unavailable, a stored batch can be
discarded locally after confirming the same possible loss of draft recovery.
Unsupported envelope versions and successfully decrypted payloads that this build
cannot parse are incompatible: erasure and retention preserve them,
and the UI asks the user to update the app.
Version metadata is checked before envelope decoding and before missing-key
erasure. Settings and day-file rewrites preserve unknown optional payload fields.
Namespace identity changed before
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
local path appears on hover. Proposed blocks group segments per matter using a
manual assignment, an open Stella edit session, or a unique matter reference or
name in the recorded details. Unmatched time stays in its own group; recorded
time not yet drafted counts toward its group's duration, and each group is
rounded up to the next six minutes. Explicit Copy summary may include document filenames. Draft
narratives are prefilled locally from recorded document names, opted-in window
titles, or app names; the user can edit them, and they are sent only after
confirmation.
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

## Confirmed draft time entries

The activity window can create a draft time entry only after the user confirms
a matter, date worked, time zone, duration, narrative, and billable choice. The
narrative is prefilled locally from recorded document names, window titles
(only when opted in), or app names. It remains editable and is sent only on
confirmation. `time_entry_commands` holds the activity caller proof
and linked-account binding; `time_entry_submit` accepts only that account and
the independently confirmed fields. The block's timestamps and returned entry
id stay in the account's encrypted local day file. Neither the network owner
nor a server response can access recorded segments, app names, or summaries.

Matter search sends only the user's picker query. Both features must be enabled
and the server independently checks the linked user's live create permission
and matter access. A successful create with a failed local marker write shows
a fixed warning and keeps the form completed, preventing an immediate retry.

The confirmed batch and its idempotency key are stored before submission.
Ordinary day rewrites and app-history deletion preserve that exact payload.
Day deletion and ordinary all-history deletion wait for pending batches to settle;
only authoritative cancellation or matching creation receipts clear readable batches.
Recovery remains available when the day has no recorded segments. A stored retry
does not block day navigation; only an active submission does. A failed receipt
write retains the same batch key for another retry.

The data-driven guards include the confirmation command owner in the activity
window's capability and caller checks, and forbid the submission network owner
from importing any local-only feature's data, including aliased imports.

## AI billing drafts

When the organization enables AI billing drafts and the user consents, the
review can ask the server to draft narratives and classifications. A request
carries, for each selected entry only, its matter, date, time zone, rounded
duration and app names, plus the document names and window titles the review
already shows, and those only when the user records window titles. Timestamps,
segments, the timeline, unselected or left-out time, exclusions and the
clipboard never leave the device.

`billing_draft_commands` holds the activity caller proof and linked-account
binding; `billing_draft_submit` accepts only that account and a request type
that refuses unknown fields. The server keeps no drafting session: a steering
request sends the previous result back for revalidation. Consent and the
personal drafting preference are stored on the server and revocable from
activity settings.

Drafts are suggestions. Nothing changes until the user accepts it, and entries
are still created only through the confirmed batch above, which may now carry
the accepted LEDES task and activity codes.
