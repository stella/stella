---
"@stll/ui": minor
---

`Accordion` now keeps closed panels as `hidden="until-found"` by default, so find-in-page reaches their content (pass `hiddenUntilFound={false}` to unmount them), and `AccordionTrigger` gains a `trailing` slot for status text before its chevron.
