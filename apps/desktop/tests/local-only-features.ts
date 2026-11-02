/**
 * The local-only features: data that never leaves the device and is served
 * only to the feature's own windows. Every guard over that boundary (no
 * network code, single-window capabilities, a verified caller on every
 * command) iterates this list, so adding a feature means adding one entry.
 * See docs/local-only-data.md.
 */
export const LOCAL_ONLY_FEATURES = [
  {
    callerType: "ClipboardCaller",
    commandOwners: [
      { module: "src/clipboard_commands.rs", prefixes: ["clipboard_"] },
    ],
    id: "clipboard",
    /**
     * What the feature may report: `classifications` sends error codes and a
     * redacted error shape (the native side drops details from these
     * windows); `fixedCodes` sends fixed codes only and its native modules
     * never touch telemetry.
     */
    telemetry: "classifications",
    nativeModules: [],
    /** Capability file → the modules `main.tsx` renders in that window. */
    windowModules: {
      "src-tauri/capabilities/clipboard-editor.json": [
        "src/clipboard/ClipboardEditor.tsx",
        "src/clipboard/ClipboardGroupFields.tsx",
        "src/clipboard/ClipboardImagePreview.tsx",
      ],
      "src-tauri/capabilities/clipboard.json": [
        "src/clipboard/ClipboardApp.tsx",
        "src/clipboard/ClipboardGroupFields.tsx",
        "src/clipboard/ClipboardImagePreview.tsx",
        "src/registry/RegistrySearch.tsx",
        "src/shared/use-clipboard-shortcut.ts",
      ],
    },
    windows: ["clipboard", "clipboard-editor"],
  },
  {
    callerType: "ActivityCaller",
    commandOwners: [
      { module: "src/activity_commands.rs", prefixes: ["activity_"] },
      { module: "src/time_entry_commands.rs", prefixes: ["time_entry_"] },
      // The one command that sends a selected entry out for a stella AI
      // draft, only with the user's consent on the server.
      {
        module: "src/billing_draft_commands.rs",
        prefixes: ["billing_draft_create_"],
      },
    ],
    id: "activity",
    telemetry: "fixedCodes",
    nativeModules: [
      { file: "tray.rs", logging: "fixedMessages" },
      { file: "../crates/macos-park/src/focused_window.rs", logging: "none" },
      { file: "../crates/macos-park/src/microphone.rs", logging: "none" },
      { file: "../crates/macos-park/src/windows_window.rs", logging: "none" },
    ],
    windowModules: {
      "src-tauri/capabilities/activity.json": [
        "src/activity/ActivityApp.tsx",
        "src/activity/ActivityCaptureDetails.tsx",
        "src/activity/ActivityDayCalendar.tsx",
        "src/activity/ActivitySuggestionCard.tsx",
        "src/activity/MatterPicker.tsx",
        "src/activity/activity-calendar-logic.ts",
        "src/activity/billing-draft-logic.ts",
        "src/activity/billing-draft-settings.ts",
        "src/activity/billing-draft-transport.ts",
        "src/activity/day-review-logic.ts",
      ],
    },
    windows: ["activity"],
  },
  {
    // Activity settings and deletion, also offered in the Settings window.
    // None of these commands returns the timeline.
    callerType: "ActivitySettingsCaller",
    commandOwners: [
      { module: "src/activity_settings.rs", prefixes: ["activity_"] },
      // Consent to stella AI drafts, which the user withdraws in Settings.
      {
        module: "src/billing_draft_settings.rs",
        prefixes: ["billing_draft_"],
      },
    ],
    id: "activity_settings",
    telemetry: "fixedCodes",
    nativeModules: [],
    windowModules: {
      "src-tauri/capabilities/default.json": [
        "src/activity/ActivitySettings.tsx",
        "src/activity/ActivityCaptureDetails.tsx",
        "src/activity/billing-draft-settings.ts",
      ],
    },
    windows: ["activity", "main"],
  },
] as const;

/** Native modules every local-only feature is built on. */
export const LOCAL_ONLY_SHARED_MODULES = [
  "feature_gate.rs",
  "foreground_app.rs",
  "foreground_app_visual.rs",
  "idle_time.rs",
  "local_store.rs",
  "local_window.rs",
] as const;

/**
 * Network modules that only decide whether a local-only feature exists. They
 * must never reach the feature's data, and the features must not reach them.
 */
export const LOCAL_ONLY_GATE_MODULES = ["feature_access.rs"] as const;

/** Native source files that belong to a feature: `<id>.rs` and `<id>_*.rs`. */
export const isFeatureModule = (
  feature: (typeof LOCAL_ONLY_FEATURES)[number],
  file: string,
) =>
  file === `${feature.id}.rs` ||
  (file.startsWith(`${feature.id}_`) && file.endsWith(".rs"));

/** Network owners accepting explicit confirmation, never recorded activity. */
export const CONFIRMED_ENTRY_NETWORK_MODULES = [
  "time_entry_submit.rs",
  "billing_draft_submit.rs",
] as const;
