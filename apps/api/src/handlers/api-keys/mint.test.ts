import { afterEach, describe, expect, test } from "bun:test";
import * as v from "valibot";

import { statements } from "@stll/permissions";

import {
  machineApiKeyPermissionsBodySchema,
  machineApiKeyScopesSchema,
  toMachineApiKeySummary,
} from "@/api/handlers/api-keys/mint";
import {
  MACHINE_API_KEY_GRANTABLE_SCOPES,
  parseMachineApiKeyPermissions,
} from "@/api/lib/machine-api-key-config";
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

describe("new machine key grant request bounds", () => {
  test("accepts every canonical resource and distinct action without changing order", () => {
    const grants = Object.fromEntries(
      Object.entries(statements).map(([resource, actions]) => [
        resource,
        actions.toReversed(),
      ]),
    );
    expect(v.parse(machineApiKeyPermissionsBodySchema, grants)).toEqual(grants);
    expect(parseMachineApiKeyPermissions(grants).type).toBe("valid");
    const scopes = MACHINE_API_KEY_GRANTABLE_SCOPES.toReversed();
    expect(v.parse(machineApiKeyScopesSchema, scopes)).toEqual(scopes);
  });

  test("new requests refuse redundant actions while existing stored grants remain readable", () => {
    const permissions = { workspace: ["read", "read"] };
    expect(v.is(machineApiKeyPermissionsBodySchema, permissions)).toBe(false);
    expect(parseMachineApiKeyPermissions(permissions).type).toBe("valid");
    expect(
      toMachineApiKeySummary(
        keyRow({ permissions: JSON.stringify(permissions) }),
      )?.permissions,
    ).toEqual(permissions);
  });

  test("bounds request shape by the grant catalog instead of accepting impossible names or counts", () => {
    const resources = Object.keys(statements);
    const actionSets = Object.values(statements);
    const longestActionLength = Math.max(
      ...actionSets.flatMap((actions) =>
        actions.map((action) => action.length),
      ),
    );
    const tooManyResources = Object.fromEntries(
      Array.from({ length: resources.length + 1 }, (_, index) => [
        `resource-${String(index)}`,
        ["read"],
      ]),
    );
    const tooManyActions = Array.from(
      { length: Math.max(...actionSets.map((actions) => actions.length)) + 1 },
      (_, index) => `a${String(index)}`,
    );
    expect(v.is(machineApiKeyPermissionsBodySchema, tooManyResources)).toBe(
      false,
    );
    expect(
      v.is(machineApiKeyPermissionsBodySchema, { workspace: tooManyActions }),
    ).toBe(false);
    expect(
      v.is(machineApiKeyPermissionsBodySchema, {
        workspace: ["x".repeat(longestActionLength + 1)],
      }),
    ).toBe(false);
  });

  test("ordinary unknown names still reach the canonical grant validator", () => {
    const unknownResource = { other: ["read"] };
    const unknownAction = { workspace: ["other"] };
    expect(
      v.parse(machineApiKeyPermissionsBodySchema, unknownResource),
    ).toEqual(unknownResource);
    expect(parseMachineApiKeyPermissions(unknownResource)).toEqual({
      type: "unknown-resource",
      resource: "other",
    });
    expect(v.parse(machineApiKeyPermissionsBodySchema, unknownAction)).toEqual(
      unknownAction,
    );
    expect(parseMachineApiKeyPermissions(unknownAction)).toEqual({
      type: "unknown-action",
      resource: "workspace",
      action: "other",
    });
  });

  test("scope sets retain their existing empty, duplicate and unknown refusals", () => {
    expect(v.is(machineApiKeyScopesSchema, [])).toBe(false);
    expect(
      v.is(machineApiKeyScopesSchema, ["stella:read", "stella:read"]),
    ).toBe(false);
    expect(v.is(machineApiKeyScopesSchema, ["unknown-scope"])).toBe(false);
  });
});
