import type { ViewProps } from "react-native";
import { View } from "react-native";

import { cn } from "../lib/utils";
import type { SeparatorContract } from "./separator.shared";

/**
 * The web's `Separator` (./separator.tsx) on a phone: a hairline in the
 * border colour, across the container or, `vertical`, down it. A list passes
 * it as the divider between its rows.
 */
export const Separator = ({
  className,
  orientation = "horizontal",
  ...props
}: ViewProps &
  SeparatorContract & {
    className?: string | undefined;
    /** A hairline holds nothing. */
    children?: never;
  }) => (
  <View
    {...props}
    accessibilityElementsHidden
    className={cn(
      "bg-border",
      orientation === "vertical" ? "w-px self-stretch" : "h-px w-full",
      className,
    )}
    importantForAccessibility="no-hide-descendants"
  />
);
