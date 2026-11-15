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

import {
  TIMER_ACTIVITY_ACTION_KEY_HOURS,
  TIMER_ACTIVITY_DEVICES_PER_USER_MAX,
  timerActivityDeviceRegistrationSchema,
} from "@stll/api-contract/timer-activity";
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
  verifyTimerActivityActionKey,
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

let sequence = 0;
const nextSequence = () => {
  sequence += 1;
  return sequence;
};

const registration = (
  overrides: Partial<TimerActivityDeviceRegistration> = {},
): TimerActivityDeviceRegistration => ({
  sequence: nextSequence(),
  actionKey: false,
  actionKeyHeld: false,
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
    ? result
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

  test("a registration older than the one filed changes nothing", async () => {
    const actor = { userId: ids.userA1, organizationId: ids.orgA };
    const late = registration({ locale: "de" });
    await register(actor);
    await register(actor, late);

    expect((await listed(actor))[0]?.locale).toBe("cs");
  });

  test("a registration that arrives after the sign-out does not bring the phone back", async () => {
    const actor = { userId: ids.userA1, organizationId: ids.orgA };
    await register(actor);
    expect(await unregister(actor)).toBe(true);
    await register(actor);

    expect(await listed(actor)).toEqual([]);
  });

  test("a later sign-in on the same phone outranks an older one, even once signed out", async () => {
    const first = { userId: ids.userA1, organizationId: ids.orgA };
    const second = { userId: ids.userA2, organizationId: ids.orgA };
    await register(first);
    await register(second, registration(), OTHER_PHONE);
    await unregister(second, OTHER_PHONE);

    expect(await listed(first)).toEqual([]);
  });

  test("a late sign-out of an older sign-in does not outrank a newer one", async () => {
    const first = { userId: ids.userA1, organizationId: ids.orgA };
    const second = { userId: ids.userA2, organizationId: ids.orgA };
    await register(first);
    await register(second, registration(), OTHER_PHONE);
    await unregister(first);

    expect((await listed(second)).map(({ deviceId }) => deviceId)).toEqual([
      OTHER_PHONE,
    ]);
  });

  test("a sign-out's mark outlives the per-person trim, so a late registration still finds it", async () => {
    const actor = { userId: ids.userA1, organizationId: ids.orgA };
    await register(actor);
    await unregister(actor);
    const late = registration();
    for (
      let index = 0;
      index < TIMER_ACTIVITY_DEVICES_PER_USER_MAX + 1;
      index++
    ) {
      await register(
        actor,
        registration({ activity: null, startToken: tokenOf(40 + index) }),
        `0198f7c4-0000-7000-8000-0000000001${String(index).padStart(2, "0")}`,
      );
    }
    await register(actor, late);

    expect(
      (await listed(actor)).some(({ deviceId }) => deviceId === PHONE),
    ).toBe(false);
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
    expect(reported?.starting).toBe(false);
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

  test("signing out stops the phone, and again is not an error", async () => {
    const actor = { userId: ids.userA1, organizationId: ids.orgA };
    await register(actor);
    await register(
      actor,
      registration({ activity: null, startToken: tokenOf(9) }),
      OTHER_PHONE,
    );

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

  test("a Lock Screen key is issued only when asked, and works only on its own phone", async () => {
    const actor = { userId: ids.userA1, organizationId: ids.orgA };
    expect((await register(actor)).actionKey).toBeNull();
    const issued = (await register(actor, registration({ actionKey: true })))
      .actionKey;
    if (issued === null) {
      expect.unreachable("a signed-in phone gets a key");
    }
    // The key lasts a day from the registration that issued it, by the
    // database's own clock.
    const [row] = await testDb
      .select({
        expiresAt: timerActivityDevices.actionKeyExpiresAt,
        seenAt: timerActivityDevices.lastSeenAt,
      })
      .from(timerActivityDevices)
      .where(eq(timerActivityDevices.userId, ids.userA1));
    expect(row?.expiresAt?.toISOString()).toBe(issued.expiresAt);
    const lifetime =
      (row?.expiresAt?.getTime() ?? 0) - (row?.seenAt.getTime() ?? 0);
    expect(Math.round(lifetime / 3_600_000)).toBe(
      TIMER_ACTIVITY_ACTION_KEY_HOURS,
    );

    expect(
      await verifyTimerActivityActionKey(ownerDb(), {
        deviceId: PHONE,
        key: issued.key,
      }),
    ).toEqual(actor);
    for (const [deviceId, key] of [
      [OTHER_PHONE, issued.key],
      [
        PHONE,
        `${issued.key.slice(0, -1)}${issued.key.endsWith("0") ? "1" : "0"}`,
      ],
      [PHONE, issued.key.replace(ids.userA1, () => ids.userA2)],
      [PHONE, "not-a-key"],
    ] as const) {
      expect(
        await verifyTimerActivityActionKey(ownerDb(), { deviceId, key }),
      ).toBeNull();
    }
    // The buttons show only once the phone says it holds the key.
    expect((await listed(actor)).map(({ actions }) => actions)).toEqual([
      false,
    ]);
    await register(actor, registration({ actionKeyHeld: true }));
    expect((await listed(actor)).map(({ actions }) => actions)).toEqual([true]);
  });

  test("a registration that arrives after a newer one gets no key", async () => {
    const actor = { userId: ids.userA1, organizationId: ids.orgA };
    const late = registration({ actionKey: true });
    await register(actor);
    expect((await register(actor, late)).actionKey).toBeNull();
  });

  test("the key before the newest keeps working, one older does not, and signing out ends both", async () => {
    const actor = { userId: ids.userA1, organizationId: ids.orgA };
    const issue = async () =>
      (await register(actor, registration({ actionKey: true }))).actionKey;
    const first = await issue();
    const second = await issue();
    if (first === null || second === null) {
      expect.unreachable("a signed-in phone gets a key");
    }
    const verify = async (key: string) =>
      await verifyTimerActivityActionKey(ownerDb(), { deviceId: PHONE, key });
    // A phone that missed the second answer still holds a working key.
    expect(await verify(first.key)).toEqual(actor);
    expect(await verify(second.key)).toEqual(actor);
    await issue();
    expect(await verify(first.key)).toBeNull();
    expect(await verify(second.key)).toEqual(actor);

    await unregister(actor);
    expect(
      await verifyTimerActivityActionKey(ownerDb(), {
        deviceId: PHONE,
        key: second.key,
      }),
    ).toBeNull();
  });

  test("deleting the account removes its phones", async () => {
    const actor = { userId: ids.userA1, organizationId: ids.orgA };
    await register(actor);
    await deletePushDevices(ownerDb(), actor.userId);

    expect(await listed(actor)).toEqual([]);
  });
});
