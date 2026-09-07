---
"@stll/ui": patch
---

`Tooltip` and `Popover` keep their popup in normal flow (`relative!`) and size the positioner to it on both axes (`w-max max-w-(--available-width)`, no `--positioner-height`). Base UI's popup viewport writes `position: absolute` inline on the popup for `side="top"` and `side="left"` to anchor size transitions; an out-of-flow popup contributes nothing to a `max-content` positioner, so every tooltip (default `side="top"`) positioned a 0px-wide box: the popup started at the anchor's centre instead of being centred on it, collision shifting never engaged, and a tooltip near the inline end painted past the viewport edge and widened the document.
