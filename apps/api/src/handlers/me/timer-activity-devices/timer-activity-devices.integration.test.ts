import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";
import * as v from "valibot";

import { timerActivityDeviceRegistrationSchema } from "@stll/api-contract/timer-activity";
import type { TimerActivityDeviceRegistration } from "@stll/api-contract/timer-activity";

import { timerActivityDevices } from "@/api/db/schema";
import { createMembershipSafeDb } from "@/api/db/scoped";
import registerTimerActivityDevice from "@/api/handlers/me/timer-activity-devices/register";
import unregisterTimerActivityDevice from "@/api/handlers/me/timer-activity-devices/unregister";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { deletePushDevices } from "@/api/lib/account-deletion-steps";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { SafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import {
  claimTimerActivityStart,
  forgetTimerActivityToken,
  listTimerActivityDevices,
} from "@/api/lib/push/timer-activity-devices";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// timeout: the shared RLS fixture builds the complete migration schema on first use.
setDefaultTimeout(120_000);

type RegisterContext = Parameters<
  typeof registerTimerActivityDevice.handler
>[0];
type UnregisterContext = Parameters<
  typeof unregisterTimerActivityDevice.handler
>[0];

let testDb: TestDatabase;
let ids: TestIds;

type Actor = {
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
};

const PHONE = "0198f7c4-0000-7000-8000-0000000000a1";
const OTHER_PHONE = "0198f7c4-0000-7000-8000-0000000000a2";
const tokenOf = (seed: number) => seed.toString(16).padStart(2, "0").repeat(32);

const registration = (
  overrides: Partial<TimerActivityDeviceRegistration> = {},
): TimerActivityDeviceRegistration => ({
  activity: { id: "activity-1", token: tokenOf(2) },
  bundleId: "app.stll.mobile.preview",
  details: true,
  environment: "production",
  link: "app.stll.preview://timers",
  locale: "cs",
  startToken: tokenOf(1),
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
  body: TimerActivityDeviceRegistration = registration(),
  deviceId = PHONE,
) => {
  const result = await registerTimerActivityDevice.handler(
    asTestRaw<RegisterContext>({
      ...contextFor(actor, "/v1/me/timer-activity-devices/:deviceId"),
      params: { deviceId },
      body: v.parse(timerActivityDeviceRegistrationSchema, body),
    }),
  );
  return "registered" in result
    ? result.registered
    : expect.unreachable(`register failed: ${JSON.stringify(result)}`);
};

const unregister = async (actor: Actor, deviceId = PHONE) => {
  const result = await unregisterTimerActivityDevice.handler(
    asTestRaw<UnregisterContext>({
      ...contextFor(actor, "/v1/me/timer-activity-devices/:deviceId"),
      params: { deviceId },
    }),
  );
  return "removed" in result
    ? result.removed
    : expect.unreachable(`unregister failed: ${JSON.stringify(result)}`);
};

/** The owner connection the update worker reads through. */
const ownerDb = () =>
  asTestRaw<
    Parameters<typeof listTimerActivityDevices>[0] &
      Parameters<typeof claimTimerActivityStart>[0] &
      Parameters<typeof deletePushDevices>[0]
  >(testDb);

const listed = async (actor: Actor) => {
  const result = await listTimerActivityDevices(ownerDb(), actor);
  return result.type === "complete"
    ? result.rows
    : expect.unreachable("the phones fit within the per-person cap");
};

const clear = async () => {
  await testDb
    .delete(timerActivityDevices)
    .where(
      inArray(timerActivityDevices.userId, [
        ids.userA1,
        ids.userA2,
        ids.userB1,
      ]),
    );
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

describe("registering a phone for the Lock Screen timer", () => {
  test("files the whole state, and a later registration replaces it", async () => {
    const actor = { userId: ids.userA1, organizationId: ids.orgA };
    await register(actor);
    await register(
      actor,
      registration({ activity: null, details: false, locale: "en" }),
    );

    expect(await listed(actor)).toEqual([
      expect.objectContaining({
        activityToken: null,
        details: false,
        deviceId: PHONE,
        locale: "en",
        startToken: tokenOf(1),
      }),
    ]);
  });

  test("updates follow the person who registered the phone last", async () => {
    const first = { userId: ids.userA1, organizationId: ids.orgA };
    const second = { userId: ids.userA2, organizationId: ids.orgA };
    await register(first);
    await register(second);

    expect(await listed(first)).toEqual([]);
    expect((await listed(second)).map(({ deviceId }) => deviceId)).toEqual([
      PHONE,
    ]);
  });

  test("a phone is listed only for the organization the app is signed in to", async () => {
    const actor = { userId: ids.userA1, organizationId: ids.orgA };
    await register(actor);
    await register({ ...actor, organizationId: ids.orgB });

    expect(await listed(actor)).toEqual([]);
  });

  test("a start is claimed once, until the app reports what it shows", async () => {
    const actor = { userId: ids.userA1, organizationId: ids.orgA };
    await register(actor, registration({ activity: null }));
    const [phone] = await listed(actor);
    const ref = { userId: actor.userId, device: phone ?? expect.unreachable() };

    expect(await claimTimerActivityStart(ownerDb(), ref)).toBe(true);
    expect(await claimTimerActivityStart(ownerDb(), ref)).toBe(false);

    await register(actor);
    const [reported] = await listed(actor);
    expect(reported?.startedAt).toBeNull();
  });

  test("a token is forgotten only while the phone has not registered again", async () => {
    const actor = { userId: ids.userA1, organizationId: ids.orgA };
    await register(actor);
    const [stale] = await listed(actor);
    await register(
      actor,
      registration({ activity: { id: "a2", token: tokenOf(3) } }),
    );

    await forgetTimerActivityToken(ownerDb(), {
      userId: actor.userId,
      device: stale ?? expect.unreachable(),
      token: "activity",
    });
    expect((await listed(actor))[0]?.activityToken).toBe(tokenOf(3));

    const [fresh] = await listed(actor);
    await forgetTimerActivityToken(ownerDb(), {
      userId: actor.userId,
      device: fresh ?? expect.unreachable(),
      token: "activity",
    });
    expect((await listed(actor))[0]?.activityToken).toBeNull();
  });

  test("signing out forgets the phone, and again is not an error", async () => {
    const actor = { userId: ids.userA1, organizationId: ids.orgA };
    await register(actor);
    await register(actor, registration(), OTHER_PHONE);

    expect(await unregister(actor)).toBe(true);
    expect(await unregister(actor)).toBe(false);
    expect((await listed(actor)).map(({ deviceId }) => deviceId)).toEqual([
      OTHER_PHONE,
    ]);
  });

  test("one person cannot remove another's phone", async () => {
    await register({ userId: ids.userA1, organizationId: ids.orgA });

    expect(
      await unregister({ userId: ids.userB1, organizationId: ids.orgB }),
    ).toBe(false);
    expect(
      await testDb
        .select({ deviceId: timerActivityDevices.deviceId })
        .from(timerActivityDevices)
        .where(eq(timerActivityDevices.userId, ids.userA1)),
    ).toHaveLength(1);
  });

  test("deleting the account removes its phones", async () => {
    const actor = { userId: ids.userA1, organizationId: ids.orgA };
    await register(actor);
    await deletePushDevices(ownerDb(), actor.userId);

    expect(await listed(actor)).toEqual([]);
  });
});
