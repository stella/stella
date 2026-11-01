---
"@stll/ui": minor
---

Add `@stll/ui/collapsible` (`Collapsible`, `CollapsibleTrigger`, `CollapsiblePanel`) for a single disclosure, with the accordion's height motion and closed content kept findable by find-in-page. `Accordion` now keeps closed panels as `hidden="until-found"` by default (pass `hiddenUntilFound={false}` to unmount them), and `AccordionTrigger` gains a `trailing` slot for status text before its chevron.
