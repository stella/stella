import { afterEach, describe, expect, test } from "bun:test";

import { toMachineApiKeySummary } from "@/api/handlers/api-keys/mint";
import type { MachineApiKeyRow } from "@/api/lib/machine-api-key-queries";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingLogger } from "@/api/tests/helpers/recording-telemetry";

const keyRow = (
  overrides: Partial<MachineApiKeyRow> = {},
): MachineApiKeyRow => ({
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  enabled: true,
  expiresAt: null,
  id: "key-1",
  lastRequest: null,
  metadata: JSON.stringify({
    organizationId: "org-acme",
    scopes: ["stella:read"],
  }),
  name: "ci-deploy",
  permissions: JSON.stringify({ workspace: ["read"] }),
  referenceId: "user-1",
  start: "stella_mk_abc",
  ...overrides,
});

describe("toMachineApiKeySummary", () => {
  let logs: RecordingLogger | null = null;

  afterEach(() => {
    logs?.restore();
    logs = null;
  });

  const unreadableRecords = (recording: RecordingLogger) =>
    recording
      .at("WARN")
      .filter(({ message }) => message === "api_keys.stored_key_unreadable")
      .map(({ attributes }) => attributes);

  test("describes a key written by these handlers without logging", () => {
    logs = installRecordingLogger();

    expect(toMachineApiKeySummary(keyRow())?.permissions).toEqual({
      workspace: ["read"],
    });
    expect(unreadableRecords(logs)).toEqual([]);
  });

  test("logs a key whose stored permissions are not JSON", () => {
    logs = installRecordingLogger();

    expect(
      toMachineApiKeySummary(keyRow({ permissions: '{"workspace":' })),
    ).toBeNull();
    expect(unreadableRecords(logs)).toEqual([
      { keyId: "key-1", column: "permissions", reason: "malformed_json" },
    ]);
  });

  test("logs a key whose stored metadata has an unexpected shape", () => {
    logs = installRecordingLogger();

    expect(
      toMachineApiKeySummary(
        keyRow({ metadata: JSON.stringify({ scopes: "stella:read" }) }),
      ),
    ).toBeNull();
    expect(unreadableRecords(logs)).toEqual([
      { keyId: "key-1", column: "metadata", reason: "unexpected_shape" },
    ]);
  });
});
