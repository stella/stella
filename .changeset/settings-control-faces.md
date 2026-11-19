---
"@stll/ui": minor
---

`@stll/ui/control-face` adds the faces a settings form's loading view needs: `FieldTriggerFace` (a select's or a field combobox's trigger), `CheckboxFace`, `SwitchFace`, `TabsFace` (a `default` tab strip) and `LabelFace` (a field's caption). Each is drawn from the classes its control renders, which move into `label-classes.ts`, `toggle-classes.ts` and `tabs-classes.ts`; `Label`, `Checkbox`, `Switch` and `Tabs` build from the same strings byte for byte. `FrameTitle` takes `tone="destructive"` for a danger zone's title. `@stll/ui/list-shell` now holds `ListGroupDescription`, which `@stll/ui/list` re-exports.
