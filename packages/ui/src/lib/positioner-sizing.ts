// Sizing contract between a Base UI positioner and the popup it positions.
//
// Base UI positions and collision-tests the positioner, not the popup, so the
// two boxes must match on both axes. Base UI writes `--positioner-width` and
// `--positioner-height` only when the popup payload changes, so a popup whose
// content grows from local state while open (a picker view swapping to an
// editor view) outgrew a positioner sized from those variables, `shift()` saw
// no overflow, and the popup ran past the viewport edge. A `max-content`
// positioner tracks the popup instead, as long as the popup is in normal flow.

export const CONTENT_SIZED_POSITIONER_CLASS_NAME =
  "w-max max-w-(--available-width)";

// Base UI's popup viewport writes `position: absolute; bottom: 0` (side top)
// or `left: 0` (side left) inline on the popup to anchor its size transitions.
// An out-of-flow child contributes nothing to `max-content`, so the positioner
// collapsed to 0px wide: Floating UI centred a 0px box on the anchor, `shift()`
// saw no overflow, and the popup painted past the viewport edge, widening the
// document. `!important` outranks the inline write. Nothing is lost: Base UI
// anchors the positioner itself through its adaptive origin, so a positioner
// sized to an in-flow popup grows from the same edge.
export const IN_FLOW_POPUP_CLASS_NAME = "relative!";
