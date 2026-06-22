import type { LucideIcon } from "lucide-react";

import { cn } from "@stll/ui/lib/utils";

type DirectionalIconProps = {
  /**
   * A horizontally-directional lucide icon (chevron / arrow / caret /
   * chevrons). It is mirrored under an RTL UI so it points the correct
   * way. Do NOT use this for orientation-independent icons (play/pause,
   * spinner/refresh/clock, magnifier, checkmark, camera, brand marks,
   * file-type or chart-axis glyphs) — those must never mirror.
   */
  icon: LucideIcon;
  className?: string;
  /**
   * Whether to mirror under RTL. Defaults to `true`. Pass
   * `flip={!isExpanded}` for disclosure chevrons that also `rotate-90`
   * on expand, so the horizontal mirror is only applied while collapsed
   * (an always-on mirror composes with the rotation and points the
   * expanded state the wrong way).
   */
  flip?: boolean;
};

/**
 * Single sanctioned way to render a direction-bearing icon. Centralizes
 * the `rtl:-scale-x-100` mirror so individual call sites can't get RTL
 * handling wrong (forget the flip, or wrongly flip a non-directional
 * icon). See `/conventions-ux` → Right-to-Left & Bidirectional.
 */
export const DirectionalIcon = ({
  icon: Icon,
  className,
  flip = true,
}: DirectionalIconProps) => (
  <Icon className={cn(flip && "rtl:-scale-x-100", className)} />
);
