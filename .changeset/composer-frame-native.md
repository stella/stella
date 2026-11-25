---
"@stll/ui": minor
---

Add the React Native `ComposerFrame` (`@stll/ui/composer-frame` on native) with the web frame's prop contract: one bar while the text fits a line, then the text across the box over a control row, back to the bar only when the draft is empty. Web and native share one layout state machine and one 320 cap token (`COMPOSER_TEXT_REGION_MAX_HEIGHT_CLASS`). The native `Textarea` takes `appearance="composer"`, which grows to the frame's cap and scrolls itself.
