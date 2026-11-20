// The select trigger's classes, with no React or Base UI: the select
// (./select.tsx) builds its trigger from them, and a loading view draws the
// trigger's face (./control-face.tsx) from the same classes, so the face and
// the trigger that replaces it share one box.

import { CONTROL_SIZE } from "../lib/control-size";
import type { ControlSize } from "../lib/control-size";

/** The trigger's metric per control size, over the field trigger's box. */
export const SELECT_TRIGGER_SIZE_CLASS_NAMES = {
  [CONTROL_SIZE.sm]:
    "min-h-8 gap-1.5 px-[calc(--spacing(2.5)-1px)] text-sm sm:min-h-7 sm:text-xs",
  [CONTROL_SIZE.default]: undefined,
  [CONTROL_SIZE.lg]: "min-h-10 sm:min-h-9",
} as const satisfies Record<ControlSize, string | undefined>;

/** The chosen value's line inside the trigger. */
export const SELECT_VALUE_CLASS_NAME =
  "data-placeholder:text-muted-foreground flex-1 truncate";

/** The up-down chevrons at the trigger's end. */
export const SELECT_TRIGGER_ICON_CLASS_NAME =
  "-me-1 size-4.5 opacity-80 sm:size-4";
