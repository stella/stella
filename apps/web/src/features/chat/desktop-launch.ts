import { sleep } from "@stll/concurrency/sleep";
import { Temporal } from "@stll/time";

import {
  createDesktopLaunch,
  DESKTOP_PING_URL,
  type DesktopLaunch,
} from "@/features/chat/desktop-launch.logic";
import { openDesktopUrl } from "@/lib/desktop-bridge";

let desktopLaunch: DesktopLaunch | undefined;

/** This page's launches of stella desktop; one desktop serves every chat. */
export const getDesktopLaunch = (): DesktopLaunch => {
  desktopLaunch ??= createDesktopLaunch({
    openDesktop: () => {
      openDesktopUrl(DESKTOP_PING_URL);
    },
    now: () => Temporal.Now.instant().epochMilliseconds,
    sleep,
  });
  return desktopLaunch;
};
