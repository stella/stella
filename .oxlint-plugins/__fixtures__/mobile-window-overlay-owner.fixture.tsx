/* oxlint-disable import/no-duplicates, no-duplicate-imports -- fixture: each import form stands on its own line */

// Passive regression fixture for
// `mobile-window-overlay-owner/mobile-window-overlay-owner`: the window layer
// above the native stack is reached only through WindowOverlay.

// oxlint-disable-next-line mobile-window-overlay-owner/mobile-window-overlay-owner -- named import
import { FullWindowOverlay } from "react-native-screens";
// oxlint-disable-next-line mobile-window-overlay-owner/mobile-window-overlay-owner -- aliased named import
import { FullWindowOverlay as Overlay } from "react-native-screens";
import * as Screens from "react-native-screens";
// expect-clean: mobile-window-overlay-owner/mobile-window-overlay-owner
import { enableScreens } from "react-native-screens";

// oxlint-disable-next-line mobile-window-overlay-owner/mobile-window-overlay-owner -- namespace member
const NamespaceOverlay = Screens.FullWindowOverlay;

// oxlint-disable-next-line mobile-window-overlay-owner/mobile-window-overlay-owner -- named re-export
export { FullWindowOverlay as ReexportedOverlay } from "react-native-screens";

export { enableScreens, FullWindowOverlay, NamespaceOverlay, Overlay };
