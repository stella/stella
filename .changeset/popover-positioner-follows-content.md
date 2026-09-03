---
"@stll/ui": patch
---

`Popover` and `Tooltip` size their positioner to the rendered popup (`w-max`, still capped by `max-w-(--available-width)`) instead of to `--positioner-width`, and pass an 8px `collisionPadding`. Base UI writes `--positioner-width` from the popup payload, so a popup whose content grew from local state (a picker view swapping to a wide editor view) left the positioner at the old width; Base UI positions and collision-tests the positioner, so `shift()` saw no overflow while the popup rendered wider and ran past the viewport edge. `max-content` also tracks `--popup-width` as it interpolates, so payload transitions keep animating their width and no longer need the variable on the positioner.
