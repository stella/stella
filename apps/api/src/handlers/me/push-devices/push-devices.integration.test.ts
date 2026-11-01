import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { asc, eq, inArray, sql } from "drizzle-orm";
import * as v from "valibot";

import {
  PUSH_DEVICES_PER_USER_MAX,
  pushDeviceRegistrationSchema,
} from "@stll/api-contract/mobile-push";
import type { PushDeviceRegistration } from "@stll/api-contract/mobile-push";

import { pushDevices } from "@/api/db/schema";
import { createMembershipSafeDb, createScopedDb } from "@/api/db/scoped";
import registerPushDevice from "@/api/handlers/me/push-devices/register";
import unregisterPushDevice from "@/api/handlers/me/push-devices/unregister";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { deletePushDevices } from "@/api/lib/account-deletion-steps";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { SafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import {
  listDeliverableDevices,
  removeDeadPushDevices,
} from "@/api/lib/push/push-devices";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// timeout: the shared RLS fixture builds the complete migration schema on first use.
setDefaultTimeout(120_000);

type RegisterContext = Parameters<typeof registerPushDevice.handler>[0];
type UnregisterContext = Parameters<typeof unregisterPushDevice.handler>[0];

let testDb: TestDatabase;
let ids: TestIds;

type Actor = {
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
};

const tokenOf = (seed: number) => seed.toString(16).padStart(2, "0").repeat(32);

const registration = (
  overrides: Partial<PushDeviceRegistration> = {},
): PushDeviceRegistration => ({
  platform: "ios",
  token: tokenOf(1),
  environment: "production",
  bundleId: "app.stll.mobile",
  appVersion: "1.0.0 (1)",
  locale: "cs-CZ",
  ...overrides,
});

const contextFor = (actor: Actor, route: ApiRoutePath) => {
  const recordAuditEvent = async () => undefined;
  return {
    safeDb: createMembershipSafeDb(testDb, {
      organizationId: actor.organizationId,
      serverValidatedWorkspaceIds: [],
      userId: actor.userId,
    }),
    session: { activeOrganizationId: actor.organizationId },
    user: { id: actor.userId },
    memberRole: sessionMemberRole("member"),
    getActiveWorkspaceIds: async () => [],
    getAccessibleWorkspaces: async () => [],
    getWorkspaceAccess: async () => null,
    orgAIConfig: null,
    orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
    managedAIResidency: "eu" as const,
    promptCachingEnabled: false,
    createAuditRecorder: () => recordAuditEvent,
    recordAuditEvent,
    request: new Request(`https://example.test${route}`),
    route,
  };
};

const register = async (
  actor: Actor,
  body: PushDeviceRegistration = registration(),
) => {
  const result = await registerPushDevice.handler(
    asTestRaw<RegisterContext>({
      ...contextFor(actor, "/v1/me/push-devices"),
      body: v.parse(pushDeviceRegistrationSchema, body),
    }),
  );
  return "device" in result
    ? result.device
    : expect.unreachable(`register failed: ${JSON.stringify(result)}`);
};

const unregister = async (actor: Actor, token: string) => {
  const result = await unregisterPushDevice.handler(
    asTestRaw<UnregisterContext>({
      ...contextFor(actor, "/v1/me/push-devices/:token"),
      params: { token },
    }),
  );
  return "removed" in result
    ? result.removed
    : expect.unreachable(`unregister failed: ${JSON.stringify(result)}`);
};

const rowsOf = async (userId: SafeId<"user">) =>
  await testDb
    .select()
    .from(pushDevices)
    .where(eq(pushDevices.userId, userId))
    .orderBy(asc(pushDevices.lastSeenAt));

/** The owner connection delivery reads through; the embedded database here. */
const ownerDb = () =>
  asTestRaw<
    Parameters<typeof listDeliverableDevices>[0] &
      Parameters<typeof removeDeadPushDevices>[0] &
      Parameters<typeof deletePushDevices>[0]
  >(testDb);

/** Delivery's device list, in tests that stay within the per-person cap. */
const deliverable = async (
  recipient: Parameters<typeof listDeliverableDevices>[1],
) => {
  const listed = await listDeliverableDevices(ownerDb(), recipient);
  return listed.type === "complete"
    ? listed.rows
    : expect.unreachable("the devices fit within the per-person cap");
};

const clear = async () => {
  await testDb
    .delete(pushDevices)
    .where(inArray(pushDevices.userId, [ids.userA1, ids.userA2, ids.userB1]));
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

beforeEach(async () => {
  await clear();
});

afterAll(async () => {
  try {
    await clear();
  } finally {
    await releaseRlsFixture();
  }
});

describe("registering a device", () => {
  test("files the device under the caller and the organization they act in", async () => {
    const device = await register({
      userId: ids.userA1,
      organizationId: ids.orgA,
    });

    expect(device).toMatchObject({
      platform: "ios",
      token: tokenOf(1),
      environment: "production",
      bundleId: "app.stll.mobile",
      appVersion: "1.0.0 (1)",
      locale: "cs-CZ",
    });
    expect(await rowsOf(ids.userA1)).toEqual([
      expect.objectContaining({
        userId: ids.userA1,
        organizationId: ids.orgA,
        token: tokenOf(1),
      }),
    ]);
  });

  test("registering again refreshes the one row, and follows the app to another organization", async () => {
    const first = await register({
      userId: ids.userA1,
      organizationId: ids.orgA,
    });
    const second = await register(
      { userId: ids.userA1, organizationId: ids.orgB },
      registration({ appVersion: "1.1.0 (7)", locale: "en-GB" }),
    );

    const rows = await rowsOf(ids.userA1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: ids.orgB,
      appVersion: "1.1.0 (7)",
      locale: "en-GB",
    });
    expect(second.createdAt).toBe(first.createdAt);
    expect(Date.parse(second.lastSeenAt)).toBeGreaterThanOrEqual(
      Date.parse(first.lastSeenAt),
    );
  });

  test("a person keeps at most the newest devices; the oldest is evicted", async () => {
    const actor = { userId: ids.userA2, organizationId: ids.orgA };
    const base = Date.UTC(2026, 0, 1);
    await testDb.insert(pushDevices).values(
      Array.from({ length: PUSH_DEVICES_PER_USER_MAX }, (_, index) => ({
        userId: ids.userA2,
        organizationId: ids.orgA,
        platform: "ios" as const,
        token: tokenOf(index + 10),
        environment: "production" as const,
        bundleId: "app.stll.mobile" as const,
        appVersion: "1.0.0",
        locale: "en",
        lastSeenAt: new Date(base + index * 60_000),
      })),
    );

    await register(actor, registration({ token: tokenOf(99) }));

    const tokens = (await rowsOf(ids.userA2)).map(({ token }) => token);
    expect(tokens).toHaveLength(PUSH_DEVICES_PER_USER_MAX);
    expect(tokens).not.toContain(tokenOf(10));
    expect(tokens).toContain(tokenOf(11));
    expect(tokens).toContain(tokenOf(99));
  });

  test("another person's devices are neither visible nor evicted", async () => {
    await register({ userId: ids.userA2, organizationId: ids.orgA });
    await register(
      { userId: ids.userA1, organizationId: ids.orgA },
      registration({ token: tokenOf(2) }),
    );

    const visible = await createScopedDb(
      testDb,
      [],
      ids.orgA,
      ids.userA1,
    )(async (tx) => await tx.select().from(pushDevices));
    expect(visible.map(({ userId }) => userId)).toEqual([ids.userA1]);
    expect(await rowsOf(ids.userA2)).toHaveLength(1);
  });

  test("row security refuses a device filed for somebody else", async () => {
    const foreign = await Result.tryPromise(
      async () =>
        await createScopedDb(
          testDb,
          [],
          ids.orgA,
          ids.userA1,
        )(
          async (tx) =>
            await tx.insert(pushDevices).values({
              userId: ids.userA2,
              organizationId: ids.orgA,
              platform: "ios",
              token: tokenOf(3),
              environment: "production",
              bundleId: "app.stll.mobile",
              appVersion: "1.0.0",
              locale: "en",
            }),
        ),
    );
    expect(Result.isError(foreign)).toBe(true);
    expect(await rowsOf(ids.userA2)).toEqual([]);
  });
});

describe("registration input", () => {
  const parse = (input: unknown) =>
    v.safeParse(pushDeviceRegistrationSchema, input);

  test("an upper-case token is accepted as lower-case hex", () => {
    const parsed = parse(registration({ token: "AB".repeat(32) }));
    expect(parsed.success && parsed.output.token).toBe("ab".repeat(32));
  });

  test.each([
    ["a short token", { token: "ab".repeat(8) }],
    ["a token that is not hex", { token: "zz".repeat(32) }],
    ["an odd-length token", { token: `${"ab".repeat(32)}a` }],
    ["another app's bundle", { bundleId: "com.example.other" }],
    ["an unknown gateway", { environment: "development" }],
    ["an unknown platform", { platform: "android" }],
    ["an empty app version", { appVersion: "" }],
    ["a locale that is no language tag", { locale: "../../etc" }],
  ])("refuses %s", (_label, overrides) => {
    expect(parse({ ...registration(), ...overrides }).success).toBe(false);
  });

  test("refuses fields it does not know, such as an owner", () => {
    expect(parse({ ...registration(), userId: "someone-else" }).success).toBe(
      false,
    );
  });

  test("the table refuses a malformed token even past the schema", async () => {
    const inserted = await Result.tryPromise(
      async () =>
        await testDb.insert(pushDevices).values({
          userId: ids.userA1,
          organizationId: ids.orgA,
          platform: "ios",
          token: "not-a-token",
          environment: "production",
          bundleId: "app.stll.mobile",
          appVersion: "1.0.0",
          locale: "en",
        }),
    );
    expect(Result.isError(inserted)).toBe(true);
  });
});

describe("unregistering a device", () => {
  test("removes the caller's device, and a repeat is a no-op", async () => {
    const actor = { userId: ids.userA1, organizationId: ids.orgA };
    await register(actor);

    expect(await unregister(actor, tokenOf(1))).toBe(true);
    expect(await unregister(actor, tokenOf(1))).toBe(false);
    expect(await rowsOf(ids.userA1)).toEqual([]);
  });

  test("cannot remove another person's registration of the same device", async () => {
    await register({ userId: ids.userA2, organizationId: ids.orgA });

    expect(
      await unregister(
        { userId: ids.userA1, organizationId: ids.orgA },
        tokenOf(1),
      ),
    ).toBe(false);
    expect(await rowsOf(ids.userA2)).toHaveLength(1);
  });
});

describe("delivery's view of devices", () => {
  test("a phone somebody else registered later alerts only them", async () => {
    await register({ userId: ids.userA1, organizationId: ids.orgA });
    await register({ userId: ids.userA2, organizationId: ids.orgA });
    await register(
      { userId: ids.userA1, organizationId: ids.orgA },
      registration({ token: tokenOf(2) }),
    );

    const a1 = await deliverable({
      userId: ids.userA1,
      organizationId: ids.orgA,
    });
    const a2 = await deliverable({
      userId: ids.userA2,
      organizationId: ids.orgA,
    });
    expect(a1.map(({ token }) => token)).toEqual([tokenOf(2)]);
    expect(a2.map(({ token }) => token)).toEqual([tokenOf(1)]);
  });

  test("devices past the per-person cap are reported, not partly alerted", async () => {
    await testDb.insert(pushDevices).values(
      Array.from({ length: PUSH_DEVICES_PER_USER_MAX + 1 }, (_, index) => ({
        userId: ids.userA1,
        organizationId: ids.orgA,
        platform: "ios" as const,
        token: tokenOf(index + 10),
        environment: "production" as const,
        bundleId: "app.stll.mobile" as const,
        appVersion: "1.0.0",
        locale: "en",
      })),
    );

    expect(
      await listDeliverableDevices(ownerDb(), {
        userId: ids.userA1,
        organizationId: ids.orgA,
      }),
    ).toEqual({ type: "overflow", cap: PUSH_DEVICES_PER_USER_MAX });
  });

  test("a device signed in to another organization is not alerted for this one", async () => {
    await register({ userId: ids.userA1, organizationId: ids.orgB });

    expect(
      await deliverable({
        userId: ids.userA1,
        organizationId: ids.orgA,
      }),
    ).toEqual([]);
  });

  test("a dead token is removed unless the device registered again since", async () => {
    await register({ userId: ids.userA1, organizationId: ids.orgA });
    await register(
      { userId: ids.userA1, organizationId: ids.orgA },
      registration({ token: tokenOf(2) }),
    );
    const [first, second] = await deliverable({
      userId: ids.userA1,
      organizationId: ids.orgA,
    });
    if (first === undefined || second === undefined) {
      expect.unreachable("both devices are deliverable");
    }
    // `second` re-registers after delivery read it; only `first` may go.
    await testDb
      .update(pushDevices)
      .set({ lastSeenAt: sql`${pushDevices.lastSeenAt} + interval '1 minute'` })
      .where(eq(pushDevices.token, second.token));

    const removed = await removeDeadPushDevices(ownerDb(), {
      userId: ids.userA1,
      devices: [first, second],
    });

    expect(removed).toBe(1);
    expect((await rowsOf(ids.userA1)).map(({ token }) => token)).toEqual([
      second.token,
    ]);
  });

  test("deleting the account erases its devices in every organization", async () => {
    await register({ userId: ids.userA1, organizationId: ids.orgA });
    await register(
      { userId: ids.userA1, organizationId: ids.orgB },
      registration({ token: tokenOf(2) }),
    );
    await register({ userId: ids.userA2, organizationId: ids.orgA });

    await deletePushDevices(ownerDb(), ids.userA1);

    expect(await rowsOf(ids.userA1)).toEqual([]);
    expect(await rowsOf(ids.userA2)).toHaveLength(1);
  });
});
