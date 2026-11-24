import { readBrowserController } from "./controller";
import {
  DESKTOP_LINK_STATE,
  type DesktopLinkState,
  readDesktopLinkState,
} from "./desktop-link";

export const DEFAULT_ACTION_ICONS = {
  16: "icon/16.png",
  32: "icon/32.png",
  48: "icon/48.png",
  128: "icon/128.png",
} as const;

export const ACTIVE_ACTION_ICONS = {
  16: "icon/16-active.png",
  32: "icon/32-active.png",
  48: "icon/48-active.png",
  128: "icon/128-active.png",
} as const;

/** Active whenever a stella web tab or stella desktop is connected. */
export const isExtensionActive = ({
  hasController,
  desktopState,
}: {
  hasController: boolean;
  desktopState: DesktopLinkState;
}): boolean => hasController || desktopState === DESKTOP_LINK_STATE.connected;

/** Updates the toolbar icon to show a green dot while connected. */
export const syncActionIcon = async (): Promise<void> => {
  const [controller, desktopState] = await Promise.all([
    readBrowserController(),
    readDesktopLinkState(),
  ]);
  const active = isExtensionActive({
    desktopState,
    hasController: controller !== null,
  });
  await chrome.action.setIcon({
    path: active ? ACTIVE_ACTION_ICONS : DEFAULT_ACTION_ICONS,
  });
};
