---
"@stll/cli": patch
---

Describe each capability's file transport as a single disposition instead of two independent booleans. A capability whose file input is optional now generates a command with the file field withheld, rather than being suppressed outright, and `capability describe` reports the media types a file leg accepts and where the work can be done when the generic path cannot carry it.
