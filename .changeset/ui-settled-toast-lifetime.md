---
"@stll/ui": patch
---

Settled toasts take their own dismissal timing: a loading toast updated to success, error or cancelled no longer keeps the loading toast's infinite lifetime, unless the update names a timeout itself.
