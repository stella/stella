import { panic } from "better-result";
import { afterEach, expect, mock, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { rlsDb } from "@/api/db/root";
import {
  API_KEY_REFUSAL_REASON,
  type ApiKeyRefusalReason,
  describeApiKeyRefusal,
} from "@/api/lib/auth/api-key-refusal-log";
import type { ResolveCredentialMemberAuthorization } from "@/api/lib/auth/member-authorization";
import { createDesktopCredentialAuthorizers } from "@/api/lib/business-registries/desktop/auth";
import {
  DESKTOP_REGISTRY_REQUEST_AUTHORIZATION_PREFIX,
  DESKTOP_REGISTRY_UNKNOWN_TOKEN_RESPONSE,
} from "@/api/lib/business-registries/desktop/request-contract";
import { API_KEY_KIND } from "@/api/lib/machine-api-key-config";
import {
  type LogRecord,
  resetLogSinkForTesting,
  setLogSinkForTesting,
} from "@/api/lib/observability/logger";
import {
  getCurrentRequestId,
  initRequestContext,
  runWithRequestIdScope,
} from "@/api/lib/observability/request-context";
import {
  resolveMachineApiKeyCredential,
  resolveOwnMachineApiKeyCredential,
} from "@/api/mcp/api-key-auth";

const START = "stella_mk_abcdef";
const SECRET = "private-tail-for-test";
const PRESENTED = `${START}${SECRET}`;
const genericMessage = "Invalid or expired API key";
const createKey = () => ({
  id: "key-one",
  start: START,
  enabled: true,
  name: "Test",
  referenceId: "user-one",
  metadata: {
    organizationId: "org-one",
    scopes: ["stella:read"],
    kind: API_KEY_KIND.machine,
  },
  permissions: { workspace: ["read"] },
  createdAt: new Date("2026-09-01"),
  expiresAt: new Date("2026-09-02"),
});
const cases = {
  invalid: { resolved: false, message: genericMessage },
  disabled: { resolved: true, message: genericMessage },
  invalid_metadata: { resolved: true, message: genericMessage },
  audience_mismatch: {
    resolved: true,
    message: "This API key is bound to the law audience. Use /mcp-law.",
  },
  invalid_permissions: { resolved: true, message: genericMessage },
  inactive_member: { resolved: true, message: genericMessage },
  role_permissions: { resolved: true, message: genericMessage },
  personal_policy: { resolved: true, message: genericMessage },
  expired: { resolved: false, message: genericMessage },
} as const satisfies Record<
  ApiKeyRefusalReason,
  { resolved: boolean; message: string }
>;

const dependenciesFor = (reason?: ApiKeyRefusalReason) => {
  const key = createKey();
  const verifyApiKey = mock();
  const resolveAuthorization = mock<ResolveCredentialMemberAuthorization>(
    async () => ({
      role: "member",
      memberId: "member-one",
      email: "test@example.test",
      workspace: null,
      emailVerified: true,
      userDeleted: false,
      enrolledFeatureIds: [],
      professionalUse: { status: "required" },
    }),
  );
  switch (reason) {
    case API_KEY_REFUSAL_REASON.invalid:
    case API_KEY_REFUSAL_REASON.expired:
      verifyApiKey.mockResolvedValue({
        valid: false,
        key: null,
        error: {
          code:
            reason === API_KEY_REFUSAL_REASON.expired
              ? "KEY_EXPIRED"
              : "KEY_NOT_FOUND",
        },
      });
      return { verifyApiKey, resolveAuthorization };
    case API_KEY_REFUSAL_REASON.disabled:
      key.enabled = false;
      break;
    case API_KEY_REFUSAL_REASON.invalidMetadata:
      verifyApiKey.mockResolvedValue({
        valid: true,
        key: { ...key, metadata: null },
        error: null,
      });
      return { verifyApiKey, resolveAuthorization };
    case API_KEY_REFUSAL_REASON.audienceMismatch:
      verifyApiKey.mockResolvedValue({
        valid: true,
        key: { ...key, metadata: { ...key.metadata, audience: "law" } },
        error: null,
      });
      return { verifyApiKey, resolveAuthorization };
    case API_KEY_REFUSAL_REASON.invalidPermissions:
      key.permissions = { workspace: ["unknown"] };
      break;
    case API_KEY_REFUSAL_REASON.inactiveMember:
      resolveAuthorization.mockResolvedValue(null);
      break;
    case API_KEY_REFUSAL_REASON.rolePermissions:
      verifyApiKey.mockResolvedValue({
        valid: true,
        key: { ...key, permissions: { organizationSettings: ["update"] } },
        error: null,
      });
      return { verifyApiKey, resolveAuthorization };
    case API_KEY_REFUSAL_REASON.personalPolicy:
      verifyApiKey.mockResolvedValue({
        valid: true,
        key: {
          ...key,
          metadata: {
            ...key.metadata,
            kind: API_KEY_KIND.personal,
            audience: "default",
          },
        },
        error: null,
      });
      return {
        verifyApiKey,
        resolveAuthorization,
        resolvePersonalPolicy: async () => "disabled" as const,
      };
    case undefined:
      break;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
  verifyApiKey.mockResolvedValue({ valid: true, key, error: null });
  return { verifyApiKey, resolveAuthorization };
};

afterEach(resetLogSinkForTesting);

for (const reason of Object.values(API_KEY_REFUSAL_REASON)) {
  test(`logs one bounded refusal without the presented secret: ${reason}`, async () => {
    const records: LogRecord[] = [];
    setLogSinkForTesting((record) => {
      records.push(record);
    });
    await runWithRequestIdScope(async () => {
      initRequestContext(new Request("https://example.test/mcp"));
      const requestId =
        getCurrentRequestId() ?? panic("Expected an initialized request id");
      const error = await rejectionOf(
        resolveMachineApiKeyCredential(PRESENTED, dependenciesFor(reason)),
      );
      expect(error).toMatchObject({ message: cases[reason].message });
      const serialized = JSON.stringify(records);
      expect(serialized).not.toContain(SECRET);
      expect(serialized.includes(START)).toBe(cases[reason].resolved);
      expect(records).toEqual([
        {
          message: "auth.api_key_refused",
          severityText: "WARN",
          attributes: {
            "auth.refusal_reason": reason,
            "auth.mode": "default",
            "request.id": requestId,
            ...(cases[reason].resolved ? { "key.start": START } : {}),
            ...(cases[reason].resolved &&
            reason !== API_KEY_REFUSAL_REASON.invalidMetadata
              ? {
                  "key.kind":
                    reason === API_KEY_REFUSAL_REASON.personalPolicy
                      ? API_KEY_KIND.personal
                      : API_KEY_KIND.machine,
                }
              : {}),
          },
        },
      ]);
    });
  });
}

test("builds only bounded attributes without request context", () => {
  for (const reason of Object.values(API_KEY_REFUSAL_REASON)) {
    expect(describeApiKeyRefusal({ reason, mode: "desktop" })).toEqual({
      "auth.refusal_reason": reason,
      "auth.mode": "desktop",
    });
    expect(
      describeApiKeyRefusal({
        reason,
        mode: "law",
        key: { start: PRESENTED, kind: API_KEY_KIND.personal },
      }),
    ).toEqual({
      "auth.refusal_reason": reason,
      "auth.mode": "law",
      "key.start": START,
      "key.kind": API_KEY_KIND.personal,
    });
  }
});

test("successful resolution emits no refusal", async () => {
  const records: LogRecord[] = [];
  setLogSinkForTesting((record) => {
    records.push(record);
  });
  const credential = await resolveMachineApiKeyCredential(
    PRESENTED,
    dependenciesFor(),
  );
  expect(credential.session.credential?.type).toBe("machine_api_key");
  expect(records).toEqual([]);
});

test("self inspection records its own mode without a request id", async () => {
  const records: LogRecord[] = [];
  setLogSinkForTesting((record) => {
    records.push(record);
  });
  expect(
    await rejectionOf(
      resolveOwnMachineApiKeyCredential(
        PRESENTED,
        dependenciesFor(API_KEY_REFUSAL_REASON.disabled),
      ),
    ),
  ).toMatchObject({ message: genericMessage });
  expect(records).toEqual([
    {
      message: "auth.api_key_refused",
      severityText: "WARN",
      attributes: {
        "auth.refusal_reason": "disabled",
        "auth.mode": "self_inspection",
        "key.start": START,
        "key.kind": "machine",
      },
    },
  ]);
});

test.each([
  { permissions: null },
  { permissions: {} },
  { permissions: { unknown: ["read"] } },
])(
  "records malformed or unsupported stored permissions: %o",
  async (override) => {
    const records: LogRecord[] = [];
    setLogSinkForTesting((record) => {
      records.push(record);
    });
    const dependencies = dependenciesFor();
    dependencies.verifyApiKey.mockResolvedValue({
      valid: true,
      key: { ...createKey(), ...override },
      error: null,
    });
    expect(
      await rejectionOf(
        resolveMachineApiKeyCredential(PRESENTED, dependencies),
      ),
    ).toMatchObject({ message: genericMessage });
    expect(
      records.map((record) => record.attributes?.["auth.refusal_reason"]),
    ).toEqual([API_KEY_REFUSAL_REASON.invalidPermissions]);
  },
);

test.each([
  { expiresAt: null },
  { expiresAt: new Date("2027-09-01") },
  { permissions: { organizationSettings: ["update"] } },
])("records personal policy refusal: %o", async (override) => {
  const records: LogRecord[] = [];
  setLogSinkForTesting((record) => {
    records.push(record);
  });
  const dependencies = dependenciesFor();
  const key = createKey();
  dependencies.verifyApiKey.mockResolvedValue({
    valid: true,
    key: {
      ...key,
      ...override,
      metadata: {
        ...key.metadata,
        kind: API_KEY_KIND.personal,
        audience: "default",
      },
    },
    error: null,
  });
  expect(
    await rejectionOf(
      resolveMachineApiKeyCredential(PRESENTED, {
        ...dependencies,
        resolvePersonalPolicy: async () => "enabled",
      }),
    ),
  ).toMatchObject({ message: genericMessage });
  expect(
    records.map((record) => record.attributes?.["auth.refusal_reason"]),
  ).toEqual([API_KEY_REFUSAL_REASON.personalPolicy]);
});

test.each([
  { code: "KEY_EXPIRED", reason: API_KEY_REFUSAL_REASON.expired },
  { code: "KEY_DISABLED", reason: API_KEY_REFUSAL_REASON.disabled },
  { code: "KEY_NOT_FOUND", reason: API_KEY_REFUSAL_REASON.invalid },
])(
  "records plugin refusal without a resolved key: %o",
  async ({ code, reason }) => {
    const records: LogRecord[] = [];
    setLogSinkForTesting((record) => {
      records.push(record);
    });
    const dependencies = dependenciesFor();
    dependencies.verifyApiKey.mockResolvedValue({
      valid: false,
      key: null,
      error: { code },
    });
    expect(
      await rejectionOf(
        resolveMachineApiKeyCredential(PRESENTED, dependencies),
      ),
    ).toMatchObject({ message: genericMessage });
    expect(records).toEqual([
      {
        message: "auth.api_key_refused",
        severityText: "WARN",
        attributes: {
          "auth.mode": "default",
          "auth.refusal_reason": reason,
        },
      },
    ]);
  },
);

test.each([
  { reason: API_KEY_REFUSAL_REASON.invalid, valid: false, key: null },
  {
    reason: API_KEY_REFUSAL_REASON.disabled,
    valid: true,
    key: { ...createKey(), enabled: false },
  },
  {
    reason: API_KEY_REFUSAL_REASON.invalidMetadata,
    valid: true,
    key: createKey(),
  },
  {
    reason: API_KEY_REFUSAL_REASON.invalidMetadata,
    valid: true,
    key: { ...createKey(), expiresAt: null, metadata: null },
  },
])(
  "desktop key refusal uses the shared bounded record: %o",
  async ({ reason, valid, key }) => {
    const records: LogRecord[] = [];
    setLogSinkForTesting((record) => {
      records.push(record);
    });
    const verifyApiKey = mock();
    verifyApiKey.mockResolvedValue({ valid, key, error: null });
    const authorizers = createDesktopCredentialAuthorizers({
      membershipDb: rlsDb,
      verifyApiKey: () => verifyApiKey,
      resolveMember: mock(),
    });
    const result = await authorizers.authorizeDesktopAccount(
      new Request("https://example.test/desktop", {
        headers: {
          authorization: `${DESKTOP_REGISTRY_REQUEST_AUTHORIZATION_PREFIX}${SECRET}`,
        },
      }),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.status).toBe(401);
      expect(result.error.message).toBe(
        DESKTOP_REGISTRY_UNKNOWN_TOKEN_RESPONSE.body.message,
      );
    }
    expect(JSON.stringify(records)).not.toContain(SECRET);
    expect(records).toEqual([
      {
        message: "auth.api_key_refused",
        severityText: "WARN",
        attributes: {
          "auth.refusal_reason": reason,
          "auth.mode": "desktop",
          ...(key ? { "key.start": START } : {}),
        },
      },
    ]);
  },
);
