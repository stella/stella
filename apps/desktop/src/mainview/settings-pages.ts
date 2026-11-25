import type { AgentSettingsFocus } from "./AgentSubscriptionsSection";

/**
 * The Settings window's pages, in sidebar order. Each id is also the
 * window's URL hash and the `tab` the native side sends with
 * `activate-tab` (`PreferencesTab` in `src-tauri/src/lib.rs`). A window the
 * native side opens for a view starts at `#tab` or `#tab/focus`.
 */
export const SETTINGS_PAGES = [
  "general",
  "dictation",
  "clipboard",
  "agents",
  "signing",
  "activity",
  "notifications",
  "permissions",
  "about",
] as const;

export type SettingsPage = (typeof SETTINGS_PAGES)[number];

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
