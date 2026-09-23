---
"@stll/cli": patch
"@stll/ui": patch
---

Template and capability commands advertise the input bounds and defaults the server already enforced. `DestructiveConfirmDialog` reports an unexpected confirm rejection instead of dropping it.
