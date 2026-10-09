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
      { module: "src/clipboard_commands.rs", prefix: "clipboard_" },
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
      ],
    },
    windows: ["clipboard", "clipboard-editor"],
  },
  {
    callerType: "ActivityCaller",
    commandOwners: [
      { module: "src/activity_commands.rs", prefix: "activity_" },
      { module: "src/time_entry_commands.rs", prefix: "time_entry_" },
    ],
    id: "activity",
    telemetry: "fixedCodes",
    nativeModules: [
      "tray.rs",
      "../crates/macos-park/src/focused_window.rs",
      "../crates/macos-park/src/windows_window.rs",
    ],
    windowModules: {
      "src-tauri/capabilities/activity.json": [
        "src/activity/ActivityApp.tsx",
        "src/activity/ActivityDayReview.tsx",
        "src/activity/ActivityTimeline.tsx",
        "src/activity/MatterPicker.tsx",
        "src/activity/day-review-logic.ts",
      ],
    },
    windows: ["activity"],
  },
] as const;

/** Native modules every local-only feature is built on. */
export const LOCAL_ONLY_SHARED_MODULES = [
  "feature_gate.rs",
  "foreground_app.rs",
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
] as const;
