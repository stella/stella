---
"@stll/ui": minor
---

`DialogPopup` (and `CommandDialogPopup`) replace the `bottomStickOnMobile` boolean with `mobileLayout`: `DIALOG_MOBILE_LAYOUT.bottomSheet` (the default, as before), `centered` (what `bottomStickOnMobile={false}` did) or the new `fullscreen`, which fills the viewport inside the safe areas below `sm`.
