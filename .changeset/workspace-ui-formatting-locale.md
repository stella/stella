---
"@stll/workspace-ui": minor
---

Add `@stll/workspace-ui/formatting` with `WorkspaceUiFormattingProvider`. Field values and column calculations format numbers, money and dates in the locale it supplies instead of `use-intl`'s locale, so a host can keep the UI language and the regional format apart. Rendering them outside the provider throws.
