---
"@stll/ui": minor
"@stll/workspace-ui": minor
---

Buttons expose the disabled reason as an accessible description and retain keyboard focus when it changes. A disabled inline text run requires a reason. File, search, and secret inputs accept a localized `disabledReason` for their action buttons. Split buttons use `primaryDisabledReason` for their primary action. Review controls use `disabledReason`, `applyingReason`, or `actionDisabledReason` to explain pending and restricted decisions.

Condition builder labels now include `noFields` and `groupFull` to explain why a condition or group cannot be added.
