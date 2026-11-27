<!-- Generated from apps/desktop/src-tauri/src/activity_data_map.rs. Do not edit. -->
<!-- Regenerate from the repository root with `bun --filter @stll/desktop activity-data-map:generate`. -->

# Activity data map

Every field Activity stores, where it is kept, whether and when it leaves the computer, and how long it stays. Nothing else is recorded: no keystrokes or typed text, no screen contents, no microphone sound and no website addresses.

Two things leave the computer, both only on the member's action: the time entries they confirm, which carry the matter, date, duration, description, billable status and any billing codes, and the stella AI draft requests they ask for once they allowed drafts. Neither carries an app identifier or a document path. Activity sends no recorded data in telemetry or logs.

Deleting: Delete day and Delete all history in Settings remove recorded days; excluding an app can delete its past stretches; the history of another account on the computer is deleted from Settings as a whole.

## Settings

- Kept: This computer, encrypted: `settings.json.enc` in the account's Activity store, sealed with the account's own key from the system keychain.
- Retention: Kept until the member changes them. Delete all history keeps them; deleting another account's history removes that account's whole store.

| Field | What it holds | Leaves this computer |
| --- | --- | --- |
| `recordingStatus` | Whether recording is off, on or paused. | Never |
| `retention` | How long recorded days are kept: a week, a month or a quarter. | Never |
| `excludedApps` | Apps never recorded: identifier and name. | Never |
| `captureDetails` | The member's choice to record window titles and documents. | Never |
| `appNameOnlyApps` | Apps recorded by name only: identifier and name. | Never |
| `browserTitleApps` | Browsers the member allowed to record tab titles: identifier and name. | Never |
| `ignoreCalls` | The member's choice not to detect calls. | Never |
| `calendarSource` | Where the day review reads calendar events from. Events are shown, never recorded. | Never |

## Day

- Kept: This computer, encrypted: `days/YYYY-MM-DD.json.enc` in the account's Activity store, sealed with the account's own key from the system keychain.
- Retention: Deleted with its day: by the hourly sweep once the day is older than the retention setting (7, 30 or 90 days), with Delete day, or with Delete all history. A day holding time entries not yet confirmed by the server, or one that cannot be read, is kept until that is resolved.

| Field | What it holds | Leaves this computer |
| --- | --- | --- |
| `segments` | The day's recorded stretches; see Segment. | Never |
| `gaps` | Stretches with no input between recorded activity; see Gap. | Never |
| `manualAssignments` | Stretches the member assigned to a matter; see Manual assignment. | Never |
| `draftedEntries` | Stretches already turned into time entries; see Drafted entry. | Never |
| `pendingBatch.idempotencyKey` | The key that keeps a confirmed batch from being created twice. | When the member confirms time entries, as those entries |
| `pendingBatch.entries` | The time entries the member confirmed and the server has not acknowledged yet: matter, date, duration, description, billable status and any billing codes. | When the member confirms time entries, as those entries |
| `pendingBatch.ranges` | The stretches each pending entry covers. | Never |

## Segment

- Kept: This computer, encrypted: `days/YYYY-MM-DD.json.enc` in the account's Activity store, sealed with the account's own key from the system keychain.
- Retention: Deleted with its day: by the hourly sweep once the day is older than the retention setting (7, 30 or 90 days), with Delete day, or with Delete all history. A day holding time entries not yet confirmed by the server, or one that cannot be read, is kept until that is resolved.

| Field | What it holds | Leaves this computer |
| --- | --- | --- |
| `appIdentifier` | The app in front: its bundle identifier or executable. | Never |
| `appName` | The app's display name. | Only in a stella AI draft request the member asks for, once allowed |
| `windowTitle` | The window or browser tab title, only with details on and, for a browser, only in browsers the member allowed. | Only in a stella AI draft request the member asks for, once allowed |
| `document` | The open document's path, with details on. A draft request carries the document's name only, never its path. | Only in a stella AI draft request the member asks for, once allowed |
| `matterId` | The matter the stretch was assigned to, if any. | Only in a stella AI draft request the member asks for, once allowed |
| `call` | Whether the stretch was time on a call. | Never |
| `start` | When the stretch started. A draft request carries the date and duration only. | Only in a stella AI draft request the member asks for, once allowed |
| `end` | When the stretch ended. A draft request carries the date and duration only. | Only in a stella AI draft request the member asks for, once allowed |

## Gap

- Kept: This computer, encrypted: `days/YYYY-MM-DD.json.enc` in the account's Activity store, sealed with the account's own key from the system keychain.
- Retention: Deleted with its day: by the hourly sweep once the day is older than the retention setting (7, 30 or 90 days), with Delete day, or with Delete all history. A day holding time entries not yet confirmed by the server, or one that cannot be read, is kept until that is resolved.

| Field | What it holds | Leaves this computer |
| --- | --- | --- |
| `start` | When the stretch with no input started. | Never |
| `end` | When it ended. | Never |
| `endedBy` | What ended it: input, a stop, or the end of the day. | Never |
| `display` | What the screen did meanwhile: stayed on, locked or slept. | Never |

## Drafted entry

- Kept: This computer, encrypted: `days/YYYY-MM-DD.json.enc` in the account's Activity store, sealed with the account's own key from the system keychain.
- Retention: Deleted with its day: by the hourly sweep once the day is older than the retention setting (7, 30 or 90 days), with Delete day, or with Delete all history. A day holding time entries not yet confirmed by the server, or one that cannot be read, is kept until that is resolved.

| Field | What it holds | Leaves this computer |
| --- | --- | --- |
| `start` | Where the stretch turned into an entry starts. | Never |
| `end` | Where it ends. | Never |
| `entryId` | The time entry the server created for it. | Never: a copy of what the stella server sent |

## Manual assignment

- Kept: This computer, encrypted: `days/YYYY-MM-DD.json.enc` in the account's Activity store, sealed with the account's own key from the system keychain.
- Retention: Deleted with its day: by the hourly sweep once the day is older than the retention setting (7, 30 or 90 days), with Delete day, or with Delete all history. A day holding time entries not yet confirmed by the server, or one that cannot be read, is kept until that is resolved.

| Field | What it holds | Leaves this computer |
| --- | --- | --- |
| `start` | Where the assigned stretch starts. | Never |
| `end` | Where it ends. | Never |
| `matterId` | The matter the member assigned it to. | Never: a copy of what the stella server sent |
| `matter.id` | The matter's id, kept to show the assignment. | Never: a copy of what the stella server sent |
| `matter.name` | The matter's name. | Never: a copy of what the stella server sent |
| `matter.reference` | The matter's reference, if any. | Never: a copy of what the stella server sent |
| `matter.color` | The matter's color, if any. | Never: a copy of what the stella server sent |
| `matter.clientName` | The matter's client, if any. | Never: a copy of what the stella server sent |

## Outage

- Kept: This computer, encrypted: `outages.json.enc` in the account's Activity store, sealed with the account's own key from the system keychain.
- Retention: Kept and deleted with the days it falls on, and never longer than 90 days.

| Field | What it holds | Leaves this computer |
| --- | --- | --- |
| `start` | When a stretch the member wanted recorded, and Activity could not record, started. | Never |
| `end` | When it ended. | Never |
| `reason` | Why Activity could not record. | Never |

## Matter learning

- Kept: This computer, encrypted: `matter-learning.json.enc` in the account's Activity store, sealed with the account's own key from the system keychain.
- Retention: Deleted with Delete all history, with the history it was learned from.

| Field | What it holds | Leaves this computer |
| --- | --- | --- |
| `revision` | Advances with every save, so two windows never overwrite each other. | Never |
| `learning.rules` | Rules the member made: a title, document path or app that names a matter. | Never |
| `learning.learned` | Words from titles and documents weighted towards the matters the member confirmed. | Never |
| `learning.tallies` | How often a candidate rule was confirmed or declined. | Never |

## Recording state

- Kept: This computer, in a small plain file per account that only the account's user can read.
- Retention: Replaced with each recording choice and server answer. It holds nothing recorded.

| Field | What it holds | Leaves this computer |
| --- | --- | --- |
| `intent` | Whether the member turned recording on, paused it or left it off. | Never |
| `answer.type` | The server's last answer about Activity for the account: granted or refused. | Never: a copy of what the stella server sent |
| `answer.confirmedAt` | When a grant was confirmed. | Never: a copy of what the stella server sent |
| `answer.expiresAt` | When the credential a grant was confirmed with expires. | Never: a copy of what the stella server sent |
| `answer.reason` | Why the server refused. | Never: a copy of what the stella server sent |
