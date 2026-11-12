---
"@stll/ui": minor
"@stll/chat": patch
"@stll/workspace-ui": minor
---

Keep text that does not fit inside its container, and show the whole of it on hover, focus or tap only where it is actually cut.

`@stll/workspace-ui/field-value` no longer exports `getIntClassName`: numeric field values render through `NumericFieldText`, which cuts them with `TruncatedText`.

`@stll/ui` widens `TruncatedText` (more `lines` values and a `hint` switch) and changes `COMPOSER_PLACEHOLDER_CLASS`; the composer placeholder renders through the new `ComposerPlaceholder`.
