import type { AgentSettingsFocus } from "./AgentSubscriptionsSection";

/**
 * The Settings window's pages, in sidebar order. Each id is also the
 * window's URL hash and the `tab` the native side sends with
 * `activate-tab` (`PreferencesTab` in `src-tauri/src/lib.rs`).
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

export const isSettingsPage = (value: unknown): value is SettingsPage =>
  SETTINGS_PAGES.some((page) => page === value);

export const isAgentSettingsFocus = (
  value: unknown,
): value is AgentSettingsFocus =>
  AGENT_SETTINGS_FOCUS.some((focus) => focus === value);
