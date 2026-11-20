import type { ActivitySettingsSnapshot } from "../../../src/activity/activity-types";
import type { DictationSnapshot as DictationSettingSnapshot } from "../../../src/mainview/DictationSetting";
import type { DictationSnapshot } from "../../../src/onboarding/use-dictation";
import type { SigningDriverStatus } from "../../../src/mainview/signing-driver-status";
import type { PermissionsSnapshot } from "../../../src/shared/permissions";
import type {
  AppSnapshot,
  DesktopAccountSnapshot,
} from "../../../src/shared/rpc";
import type { ClipboardShortcutSnapshot } from "../../../src/shared/shortcut-keys";
import type { MicrophonesSnapshot } from "../../../src/mainview/dictation-microphone";

/**
 * What the native side answers the settings and setup windows in the
 * browser harness: a linked account, a shortcut, permission rows and the
 * app state, shaped like the real snapshots.
 */

export const SHORTCUT = {
  defaultKeys: { code: "KeyV", modifiers: ["super", "shift"] },
  keys: { code: "KeyV", modifiers: ["super", "shift"] },
  registration: "active",
} as const satisfies ClipboardShortcutSnapshot;

export const PERMISSIONS = {
  rows: [
    { permission: "notifications", status: "notDetermined" },
    { permission: "openAtLogin", status: "granted" },
    { permission: "accessibility", status: "notDetermined" },
  ],
} as const satisfies PermissionsSnapshot;

/** What the setup window reads with dictation available: its microphone
 *  row joins the others. */
export const SETUP_PERMISSIONS = {
  rows: [
    ...PERMISSIONS.rows,
    { permission: "microphone", status: "notDetermined" },
  ],
} as const satisfies PermissionsSnapshot;

/** Dictation turned on with its speech model in place: the tallest state of
 *  its setup step, with both permission rows and the field to try it. */
export const DICTATION_READY = {
  available: true,
  cleanup: true,
  cloudAvailable: true,
  cloudModel: null,
  customWords: [],
  destination: "local",
  enabled: true,
  failure: null,
  holdKey: "combination",
  keys: { code: "Space", modifiers: ["control", "alt"] },
  model: { status: "ready" },
  modelBytes: 740_363_168,
  phase: "idle",
  shareTextBeforeCursor: false,
  shareWindowTitle: false,
  shortcutTaken: false,
  textBeforeCursorAvailable: true,
} as const satisfies DictationSnapshot;

/** Dictation in Settings at its tallest: stella AI with a model whose
 *  provider keeps the audio, cleanup with both context switches, custom
 *  words, and the speech model still on this computer. */
export const SETTINGS_DICTATION = {
  available: true,
  cleanup: true,
  cloudAvailable: true,
  cloudModel: "elevenlabs-direct/scribe-v3",
  customWords: ["Libeňská", "custom terms list", "22 Cdo 120/2026"],
  destination: "cloud",
  enabled: true,
  failure: null,
  failureKeptInHistory: false,
  holdKey: "fn",
  holdKeys: ["fn", "rightOption", "rightCommand", "combination"],
  holdKeyWaiting: false,
  keepsInHistory: true,
  keys: { code: "Space", modifiers: ["control", "alt"] },
  language: {
    choice: "auto",
    inferred: ["cs", "en"],
    supported: ["cs", "en", "sk"],
  },
  model: { status: "ready" },
  modelBytes: 740_363_168,
  phase: "idle",
  shareTextBeforeCursor: false,
  shareWindowTitle: false,
  shortcutTaken: false,
  textBeforeCursorAvailable: true,
} as const satisfies DictationSettingSnapshot;

/** The region's stella AI transcription models. */
export const CLOUD_MODELS = {
  defaultModelId: "mistralai/voxtral-mini-transcribe",
  models: [
    {
      displayName: "Voxtral Mini Transcribe",
      id: "mistralai/voxtral-mini-transcribe",
      outsideRegion: false,
      provider: "Mistral AI",
      retainsData: false,
    },
    {
      displayName: "Scribe v3",
      id: "elevenlabs-direct/scribe-v3",
      outsideRegion: true,
      provider: "ElevenLabs",
      retainsData: true,
    },
  ],
  unavailable: null,
};

/** A chosen smart card driver, as the macOS signing setting reports it. */
export const SIGNING_DRIVER = {
  path: "/Library/Frameworks/eToken.framework/Versions/A/libeToken.dylib",
  problem: null,
} as const satisfies SigningDriverStatus;

export const ACCOUNT = {
  account: {
    email: "eliska.novakova@example.test",
    name: "Eliška Nováková",
    verifiedAt: "2026-10-27T07:30:00.000Z",
  },
  expiresAt: "2026-11-26T07:30:00.000Z",
  identity: { organizationId: "organization-1", userId: "user-1" },
  server: "https://app.example.test",
  status: "connected",
} as const satisfies DesktopAccountSnapshot;

export const APP_STATE = {
  documentRecovery: {
    edits: [],
    unassigned: false,
    pending: false,
    access: "available",
  },
  bridgePort: 45_901,
  bridgeVersion: 1,
  capabilities: [],
  notificationPreferences: {
    documentReady: true,
    revisionCreated: true,
    syncIssues: false,
  },
  runningSince: "2026-10-27T07:00:00.000Z",
  sessions: [],
  trustedSelfHostConnections: [],
  update: {
    baseUrl: null,
    channel: null,
    currentHash: null,
    currentVersion: "0.9.4",
    lastCheckedAt: null,
    latestHash: null,
    latestVersion: null,
    status: "idle",
    statusMessage: "",
    updateAvailable: false,
    updateReady: false,
  },
} satisfies AppSnapshot;

/** A recording account's activity settings, with a few apps on the day. */
export const ACTIVITY_SETTINGS = {
  date: "2026-10-27",
  today: "2026-10-27",
  earliestDate: "2026-09-28",
  latestDate: "2026-10-27",
  deletionStatus: "available",
  persistence: "encrypted",
  retention: "month",
  excludedApps: [{ identifier: "com.example.music", name: "Example Music" }],
  otherAccountHistoryDays: 2,
  captureDetails: true,
  detectCalls: true,
  appNameOnlyApps: [{ identifier: "com.example.mail", name: "Example Mail" }],
  detailsAccess: "ready",
  browserApps: [{ identifier: "com.example.browser", name: "Example Browser" }],
  browserTitleApps: [],
  apps: [
    { identifier: "com.example.editor", name: "Example Editor" },
    { identifier: "com.example.browser", name: "Example Browser" },
    { identifier: "com.example.mail", name: "Example Mail" },
  ],
  sourceAppVisuals: [],
} satisfies ActivitySettingsSnapshot;

/** The microphones Settings lists: the built-in one and a Bluetooth headset. */
export const MICROPHONES: MicrophonesSnapshot = {
  chosen: null,
  chosenMissing: null,
  defaultName: "AirPods Pro 3",
  devices: [
    {
      bluetooth: false,
      id: "coreaudio:BuiltInMicrophoneDevice",
      name: "Built-in Microphone",
    },
    { bluetooth: true, id: "coreaudio:AA-BB-CC:input", name: "AirPods Pro 3" },
  ],
};
