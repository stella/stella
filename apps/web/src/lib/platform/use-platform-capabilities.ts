import { useIsMobile } from "@stll/ui/use-mobile";

import { detectDesktopPlatform } from "@/lib/desktop-downloads";
import {
  type PlatformCapabilities,
  REQUIREMENT,
  type Requirement,
} from "@/lib/platform/requirements.logic";

/** The requirements this device and the current layout meet. */
export const usePlatformCapabilities = (): PlatformCapabilities => {
  const sidePanel = !useIsMobile();
  const met: Requirement[] = [];
  if (sidePanel) {
    met.push(REQUIREMENT.sidePanel);
  }
  if (detectDesktopPlatform() !== "other") {
    met.push(REQUIREMENT.desktopAppHost);
  }
  return new Set(met);
};
