---
"@stll/ui": patch
"@stll/chat": patch
"@stll/workspace-ui": minor
---

Keep text that does not fit inside its container, and show the whole of it on hover, focus or tap only where it is actually cut.

`@stll/workspace-ui` no longer exports `getIntClassName`: numeric field values render through `NumericFieldText`, which cuts them with `TruncatedText`.
