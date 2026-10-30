import type { ActivityIndicatorProps } from "react-native";
import { ActivityIndicator } from "react-native";

import type { LoaderContract, LoaderSize } from "./loader.shared";

/** The platform's indicator comes in two sizes; `lg` is a region's. */
const INDICATOR_SIZE = {
  sm: "small",
  md: "small",
  lg: "large",
} as const satisfies Record<LoaderSize, ActivityIndicatorProps["size"]>;

type LoaderProps = Omit<ActivityIndicatorProps, "size"> & {
  className?: string | undefined;
  /** The colour is the loader's own: the muted foreground, as on the web. */
  color?: never;
  /** Named through `label`, as on the web. */
  accessibilityLabel?: never;
  size?: LoaderSize | undefined;
} & (
    | {
        variant?: "status";
        /**
         * What is pending. Optional on a phone, unlike the web: the
         * platform's indicator already announces itself as in progress.
         */
        label?: string | undefined;
      }
    | { variant: "decorative"; label?: never }
  );

/**
 * The indeterminate loading indicator, as the web's `Loader` (./loader.tsx):
 * the platform's spinner in the muted foreground, at the web's sizes.
 */
export const Loader = ({
  label,
  size = "md",
  variant = "status",
  ...props
}: LoaderProps) => (
  <ActivityIndicator
    {...props}
    accessibilityElementsHidden={variant === "decorative"}
    accessibilityLabel={label}
    colorClassName="accent-muted-foreground"
    importantForAccessibility={
      variant === "decorative" ? "no-hide-descendants" : "auto"
    }
    size={INDICATOR_SIZE[size]}
  />
);

export type { LoaderContract };
