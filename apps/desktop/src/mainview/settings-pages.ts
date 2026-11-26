import { panic } from "better-result";

import type { DesktopFeature } from "../shared/desktop-features";
import { DESKTOP_FEATURES } from "../shared/desktop-features";
import type { AgentSettingsFocus } from "./AgentSubscriptionsSection";

/**
 * The Settings window's pages; `SIDEBAR_PAGES` orders them. Each id is also the
 * window's URL hash and the `tab` the native side sends with
 * `activate-tab` (`PreferencesTab` in `src-tauri/src/lib.rs`). A window the
 * native side opens for a view starts at `#tab` or `#tab/focus`.
 */
export const SETTINGS_PAGES = [
  "general",
  "clipboard",
  "signing",
  "dictation",
  "agents",
  "activity",
  "notifications",
  "permissions",
  "about",
] as const;

export type SettingsPage = (typeof SETTINGS_PAGES)[number];

/** Where a page sits in the sidebar: with a feature, in the order every
 *  surface lists the features in (after that feature's own page when it
 *  `follows` it), or among the closing pages. */
type PagePlace =
  { feature: DesktopFeature; follows: boolean } | { closing: number };

const PAGE_PLACES = {
  // Documents have no page of their own: General holds them.
  general: { feature: "documents", follows: false },
  clipboard: { feature: "clipboard", follows: false },
  signing: { feature: "signing", follows: false },
  dictation: { feature: "dictation", follows: false },
  agents: { feature: "dictation", follows: true },
  activity: { feature: "activity", follows: false },
  notifications: { closing: 0 },
  permissions: { closing: 1 },
  about: { closing: 2 },
} as const satisfies Record<SettingsPage, PagePlace>;

const sidebarRank = (page: SettingsPage): number => {
  const place: PagePlace = PAGE_PLACES[page];
  if ("closing" in place) {
    return DESKTOP_FEATURES.length * 2 + place.closing;
  }
  const index = DESKTOP_FEATURES.indexOf(place.feature);
  if (index === -1) {
    return panic(`The shared feature order leaves out ${place.feature}`);
  }
  return index * 2 + (place.follows ? 1 : 0);
};

/** The pages in sidebar order: the features' pages in the shared feature
 *  order (`src/shared/desktop-features.ts`), then the closing pages. */
// Sorted in place, a fresh array: older WebViews lack `toSorted`.
export const SIDEBAR_PAGES: readonly SettingsPage[] = [...SETTINGS_PAGES].sort(
  (first, second) => sidebarRank(first) - sidebarRank(second),
);

/** The pages below the sidebar's divider: the app's own records and
 *  housekeeping rather than features. */
export const SETTINGS_PAGES_AFTER_DIVIDER = [
  "activity",
  "notifications",
  "permissions",
  "about",
] as const satisfies readonly SettingsPage[];

/**
 * Where on the AI and agents page a `stella://settings/agents` link scrolls
 * to: the coding agents' group or one agent's card. Native code sends only
 * these ids (`AgentSettingsFocus` in `src-tauri/src/lib.rs`).
 */
const AGENT_SETTINGS_FOCUS = [
  "agents",
  "codex",
  "claude-code",
] as const satisfies readonly AgentSettingsFocus[];

const isSettingsPage = (value: unknown): value is SettingsPage =>
  SETTINGS_PAGES.some((page) => page === value);

const isAgentSettingsFocus = (value: unknown): value is AgentSettingsFocus =>
  AGENT_SETTINGS_FOCUS.some((focus) => focus === value);

/** A page the native side opens and what it asks for there. */
export type SettingsView = {
  page: SettingsPage;
  agentFocus: AgentSettingsFocus | null;
  dictationFocus: "microphone" | null;
};

/** The view a native `tab` and `focus` name; null for an unknown page. A
 *  focus counts only on the page it belongs to. */
export const settingsView = ({
  tab,
  focus,
}: {
  tab: unknown;
  focus?: unknown;
}): SettingsView | null => {
  if (!isSettingsPage(tab)) {
    return null;
  }
  return {
    page: tab,
    agentFocus: tab === "agents" && isAgentSettingsFocus(focus) ? focus : null,
    dictationFocus:
      tab === "dictation" && focus === "microphone" ? focus : null,
  };
};
