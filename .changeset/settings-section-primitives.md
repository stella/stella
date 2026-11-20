---
"@stll/ui": minor
---

`@stll/ui/settings` holds the pieces settings pages are composed from: `SettingsSection` (a title, one quiet line and an optional trailing action over one list surface), `SettingsRow` (an optional media tile, a title, one secondary line and a trailing control; `interaction="label"` makes the row's text the label of its switch or checkbox), `SettingsPanel` (a form or other content on the same surface) and `settingsRowIds`. It imports no Base UI, so a pending view can draw it. `ListGroupTitle` takes `tone="destructive"`, and `ListGroupAction` and `ListItemMedia` move to `@stll/ui/list-shell`; `@stll/ui/list` still exports both.
