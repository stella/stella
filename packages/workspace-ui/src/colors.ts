/**
 * Option colours resolve in the kit. This module stays as the workspace-facing
 * import path so call sites do not have to move.
 */
export type { ColorVariants, OptionColor } from "@stll/ui/option-color";
export {
  emptyColor,
  optionColors,
  resolveOptionColor,
} from "@stll/ui/option-color";
