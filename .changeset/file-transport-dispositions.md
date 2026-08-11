---
"@stll/cli": minor
---

Describe each capability's file transport as a single disposition instead of two independent booleans. `list_capabilities` and `describe_capability` now carry a `transport` object naming the file field, whether it is required, the media types each leg accepts, and where the work can be done when the generic path cannot carry it; the `requiresFileInput` and `returnsFileResponse` fields are removed, with no compatibility aliases. A capability whose file input is optional now generates a command with the file field withheld, rather than being suppressed outright.
