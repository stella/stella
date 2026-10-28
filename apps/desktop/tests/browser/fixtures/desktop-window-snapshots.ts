import type { PermissionsSnapshot } from "../../../src/shared/permissions";
import type {
  AppSnapshot,
  DesktopAccountSnapshot,
} from "../../../src/shared/rpc";
import type { ClipboardShortcutSnapshot } from "../../../src/shared/shortcut-keys";

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
