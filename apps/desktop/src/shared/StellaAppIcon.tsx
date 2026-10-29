import { cn } from "@stll/ui/utils";

import stellaAppIcon from "./stella-app-icon.svg";

/**
 * The app's own icon, the blue tile the Dock and the installer show. Where
 * the desktop app stands for itself it uses this, not the bare symbol on a
 * theme-coloured tile, so it reads the same in light and dark. It always
 * sits beside text that names the app, so it is decorative.
 */
export const StellaAppIcon = ({ className }: { className: string }) => (
  <img
    alt=""
    className={cn("shrink-0", className)}
    draggable={false}
    src={stellaAppIcon}
  />
);
