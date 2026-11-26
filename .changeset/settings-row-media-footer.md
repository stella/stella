---
"@stll/ui": patch
---

`SettingsRow` starts its footer on the title's edge when the row has media, so every line of the row's text shares one start edge, and takes an optional `target`: the row then carries `data-settings-target`, can take focus from script, and is marked while `data-highlighted` is set, for a settings link that brings it into view.
