import {
  emptyColor,
  optionColors,
  resolveOptionColor,
} from "@stll/ui/option-color";

import type { CreatableContentType } from "@/components/workspaces/properties/composer-primitives";
import type { SortHint } from "@/components/workspaces/properties/sort-property";

export const isCreatableContentType = (t: string): t is CreatableContentType =>
  t === "text" ||
  t === "single-select" ||
  t === "multi-select" ||
  t === "date" ||
  t === "int";

/** Map a property content type to a sort hint. */
export const toSortHint = (contentType: string): SortHint => {
  switch (contentType) {
    case "date":
      return "date";
    case "int":
      return "number";
    default:
      return "text";
  }
};

export type { ColorVariants } from "@stll/ui/option-color";
export { emptyColor, optionColors, resolveOptionColor };
