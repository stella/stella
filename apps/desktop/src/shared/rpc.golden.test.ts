import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  isAppSnapshot,
  type AppSnapshot,
  type DesktopNotificationPreferences,
  type DesktopUpdateSnapshot,
  type LinkedAccountSnapshot,
  type OpenDocxRequest,
  type OpenDocxResponse,
  type SessionSnapshot,
  type TrustedSelfHostConnection,
} from "./rpc";

// Golden-fixture contract for the desktop bridge RPC surface.
//
// `rpc.ts` (TypeScript) and `src-tauri/src/types.rs` (Rust serde) each
// own a copy of every message that crosses the web <-> desktop bridge.
// The bug class this suite guards against is silent drift between those
// two definitions: a field renamed on one side, a `rename_all` dropped,
// an optional made required, a new field added to one side only.
//
// The fixtures under `apps/desktop/fixtures/rpc/*.json` are the single
// shared source of truth. This test asserts the TypeScript side:
//   1. every fixture deep-equals a typed literal that `satisfies` the
//      corresponding `rpc.ts` type (compile-time drift is caught by the
//      `typecheck` script; on-disk drift is caught by the deep-equal);
//   2. every fixture round-trips through JSON.parse/stringify unchanged
//      (no `undefined` leakage, key order irrelevant);
//   3. every object key is camelCase, mirroring Rust's
//      `#[serde(rename_all = "camelCase")]`;
//   4. the shipped `isAppSnapshot` runtime guard accepts the canonical
//      snapshot and rejects structurally broken variants.
//
// The Rust counterpart (`types.rs` `mod fixture_tests`) deserializes the
// same files via serde, so a change on either side that is not mirrored
// in the fixtures fails one of the two suites.

const FIXTURE_DIR = path.join(import.meta.dir, "../../fixtures/rpc");

const readFixture = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), "utf-8"));

// Fixtures are hand-authored JSON objects (never arrays or primitives); this
// guard narrows the parsed `unknown` before mutating tests spread/drop keys,
// rather than asserting the shape blind.
const readFixtureRecord = (name: string): Record<string, unknown> => {
  const parsed = readFixture(name);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`fixture ${name} is not a JSON object`);
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed above: plain JSON object, not null/array
  return parsed as Record<string, unknown>;
};

const collectKeys = (value: unknown, keys: string[] = []): string[] => {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKeys(item, keys);
    }
    return keys;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, nested] of Object.entries(value)) {
      keys.push(key);
      collectKeys(nested, keys);
    }
  }
  return keys;
};

const CAMEL_CASE = /^[a-z][a-zA-Z0-9]*$/u;

// Each entry pairs a fixture file with a literal typed via `satisfies`.
// The `satisfies` is the compile-time half of the drift guard; the
// runtime `toEqual` is the on-disk half.
const appSnapshot = {
  bridgePort: 45_901,
  bridgeVersion: 7,
  capabilities: ["self-host.connect"],
  linkedAccount: {
    email: "counsel@example.com",
    name: "Jane Counsel",
    verifiedAt: "2026-07-01T09:30:00Z",
  },
  notificationPreferences: {
    documentReady: true,
    revisionCreated: true,
    syncIssues: false,
  },
  runningSince: "2026-07-18T08:00:00Z",
  sessions: [
    {
      baseVersionNumber: 3,
      entityId: "8f3b2c1a-9d4e-4f6a-8b2c-1a9d4e4f6a8b",
      fileName: "merger-agreement.docx",
      filePath: "/Users/jane/Stella/merger-agreement.docx",
      id: "b2d4f6a8-1c3e-4a5b-9c7d-2e4f6a8b0c1d",
      lastCheckpointAt: "2026-07-18T10:15:00Z",
      lastError: null,
      pendingFinalize: false,
      propertyId: "22222222-2222-4222-8222-222222222222",
      status: "ready",
      takeoverDetected: false,
      workspaceId: "33333333-3333-4333-8333-333333333333",
    },
  ],
  trustedSelfHostConnections: [
    {
      apiBaseUrl: "https://api.selfhost.example",
      trustedAt: "2026-07-10T12:00:00Z",
      webOrigin: "https://app.selfhost.example",
    },
  ],
  update: {
    baseUrl: "https://downloads.example.com/desktop",
    channel: "stable",
    currentHash:
      "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    currentVersion: "1.4.2",
    lastCheckedAt: "2026-07-18T09:00:00Z",
    latestHash:
      "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    latestVersion: "1.4.3",
    status: "available",
    statusMessage: "An update is available.",
    updateAvailable: true,
    updateReady: false,
  },
} as const satisfies AppSnapshot;

const sessionSyncing = {
  baseVersionNumber: 0,
  entityId: "44444444-4444-4444-8444-444444444444",
  fileName: "settlement-draft.docx",
  filePath: "/Users/jane/Stella/settlement-draft.docx",
  id: "55555555-5555-4555-8555-555555555555",
  lastCheckpointAt: null,
  lastError: null,
  pendingFinalize: true,
  propertyId: "66666666-6666-4666-8666-666666666666",
  status: "syncing",
  takeoverDetected: true,
  workspaceId: "77777777-7777-4777-8777-777777777777",
} as const satisfies SessionSnapshot;

const sessionError = {
  baseVersionNumber: 12,
  entityId: "88888888-8888-4888-8888-888888888888",
  fileName: "nda.docx",
  filePath: "/Users/jane/Stella/nda.docx",
  id: "99999999-9999-4999-8999-999999999999",
  lastCheckpointAt: "2026-07-18T11:02:00Z",
  lastError: "Checkpoint upload failed: connection reset",
  pendingFinalize: false,
  propertyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  status: "error",
  takeoverDetected: false,
  workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
} as const satisfies SessionSnapshot;

const openDocxRequest = {
  apiBaseUrl: "https://api.example.com",
  entityId: "11111111-1111-4111-8111-111111111111",
  linkedAccount: {
    email: "counsel@example.com",
    name: "Jane Counsel",
    verifiedAt: "2026-07-01T09:30:00Z",
  },
  propertyId: "22222222-2222-4222-8222-222222222222",
  remoteSession: {
    baseVersionNumber: 2,
    downloadUrl: "https://s3.example.com/doc.docx?sig=abc123",
    fileName: "motion.docx",
    lastCheckpointAt: null,
    resumedFromCheckpoint: false,
    sessionId: "e8400e29-1d4a-4716-8a3a-2c83de7ab2e6",
    sessionToken: "sess-tok-abc123",
    tookOverExistingSession: false,
  },
  workspaceId: "33333333-3333-4333-8333-333333333333",
} as const satisfies OpenDocxRequest;

const openDocxResponse = {
  alreadyOpen: false,
  filePath: "/Users/jane/Stella/motion.docx",
  sessionId: "e8400e29-1d4a-4716-8a3a-2c83de7ab2e6",
} as const satisfies OpenDocxResponse;

const linkedAccount = {
  email: "solo@example.com",
  name: null,
  verifiedAt: "2026-06-15T14:20:00Z",
} as const satisfies LinkedAccountSnapshot;

const desktopUpdate = {
  baseUrl: null,
  channel: null,
  currentHash: null,
  currentVersion: "1.4.2",
  lastCheckedAt: null,
  latestHash: null,
  latestVersion: null,
  status: "disabled",
  statusMessage: "Updates will appear here once configured.",
  updateAvailable: false,
  updateReady: false,
} as const satisfies DesktopUpdateSnapshot;

const trustedSelfHost = {
  apiBaseUrl: "https://api.selfhost.example",
  trustedAt: "2026-07-10T12:00:00Z",
  webOrigin: "https://app.selfhost.example",
} as const satisfies TrustedSelfHostConnection;

const notificationPreferences = {
  documentReady: true,
  revisionCreated: false,
  syncIssues: true,
} as const satisfies DesktopNotificationPreferences;

const cases: { expected: unknown; file: string; name: string }[] = [
  { expected: appSnapshot, file: "app-snapshot.json", name: "AppSnapshot" },
  {
    expected: sessionSyncing,
    file: "session-snapshot-syncing.json",
    name: "SessionSnapshot (syncing)",
  },
  {
    expected: sessionError,
    file: "session-snapshot-error.json",
    name: "SessionSnapshot (error)",
  },
  {
    expected: openDocxRequest,
    file: "open-docx-request.json",
    name: "OpenDocxRequest",
  },
  {
    expected: openDocxResponse,
    file: "open-docx-response.json",
    name: "OpenDocxResponse",
  },
  {
    expected: linkedAccount,
    file: "linked-account.json",
    name: "LinkedAccountSnapshot",
  },
  {
    expected: desktopUpdate,
    file: "desktop-update.json",
    name: "DesktopUpdateSnapshot",
  },
  {
    expected: trustedSelfHost,
    file: "trusted-self-host-connection.json",
    name: "TrustedSelfHostConnection",
  },
  {
    expected: notificationPreferences,
    file: "notification-preferences.json",
    name: "DesktopNotificationPreferences",
  },
];

describe("desktop bridge RPC golden fixtures", () => {
  for (const { expected, file, name } of cases) {
    test(`${name} fixture matches the typed rpc.ts shape`, () => {
      const parsed = readFixture(file);
      expect(parsed).toEqual(expected);
    });

    test(`${name} fixture round-trips through JSON unchanged`, () => {
      const parsed = readFixture(file);
      // Serialize then re-parse to prove the wire form is stable: no
      // undefined leakage, no key reordering that changes the value. This
      // deliberately exercises JSON (not structuredClone), since JSON is
      // the actual bridge transport.
      const serialized = JSON.stringify(parsed);
      expect(JSON.parse(serialized)).toEqual(parsed);
    });

    test(`${name} fixture uses only camelCase keys`, () => {
      for (const key of collectKeys(readFixture(file))) {
        expect(key).toMatch(CAMEL_CASE);
      }
    });
  }

  test("isAppSnapshot accepts the canonical app-snapshot fixture", () => {
    expect(isAppSnapshot(readFixture("app-snapshot.json"))).toBe(true);
  });

  test("isAppSnapshot rejects a snapshot missing a required field", () => {
    const parsed = readFixtureRecord("app-snapshot.json");
    const { bridgeVersion: _dropped, ...withoutBridgeVersion } = parsed;
    expect(isAppSnapshot(withoutBridgeVersion)).toBe(false);
  });

  test("isAppSnapshot rejects a snapshot whose capabilities are not strings", () => {
    const parsed = readFixtureRecord("app-snapshot.json");
    expect(isAppSnapshot({ ...parsed, capabilities: [1, 2, 3] })).toBe(false);
  });

  test("isAppSnapshot rejects non-object input", () => {
    expect(isAppSnapshot(null)).toBe(false);
    expect(isAppSnapshot("app-snapshot")).toBe(false);
    expect(isAppSnapshot([])).toBe(false);
  });
});
