import { Value } from "@sinclair/typebox/value";
import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import { user as authUser, member } from "@/api/db/auth-schema";
import { timeDailyTargets, featureEnrolments } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import type { AuditEvent } from "@/api/lib/audit-log";
import { dailyTargetBody } from "@/api/lib/billing/daily-target";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import updateMemberDailyTarget from "../../members/daily-target/update";
import updateMyDailyTarget from "./update";

type OwnContext = Parameters<typeof updateMyDailyTarget.handler>[0];
type MemberContext = Parameters<typeof updateMemberDailyTarget.handler>[0];
let db: TestDatabase;
let ids: TestIds;

const cleanup = async () => {
  await db
    .delete(timeDailyTargets)
    .where(
      and(
        inArray(timeDailyTargets.organizationId, [ids.orgA, ids.orgB]),
        inArray(timeDailyTargets.userId, [ids.userA1, ids.userA2, ids.userB1]),
      ),
    );
};
beforeAll(async () => {
  const fixture = await getRlsFixture();
  db = fixture.testDb;
  ids = fixture.ids;

  await db
    .update(authUser)
    .set({ emailVerified: true })
    .where(inArray(authUser.id, [ids.userA1, ids.userAdmin]));
  await db
    .insert(featureEnrolments)
    .values([
      {
        organizationId: ids.orgA,
        userId: ids.userA1,
        featureId: "time-billing",
      },
      {
        organizationId: ids.orgA,
        userId: ids.userAdmin,
        featureId: "time-billing",
      },
      {
        organizationId: ids.orgB,
        userId: ids.userA1,
        featureId: "time-billing",
      },
    ])
    .onConflictDoNothing();
});
beforeEach(cleanup);
afterAll(async () => {
  try {
    await cleanup();
  } finally {
    await releaseRlsFixture();
  }
});

const auditRecorder = () => {
  const events: AuditEvent[] = [];
  return {
    events,
    record: async (_tx: unknown, event: AuditEvent | AuditEvent[]) => {
      events.push(...(Array.isArray(event) ? event : [event]));
    },
  };
};

type OwnUpdateOptions = {
  minutes: number | null;
  organizationId?: TestIds["orgA"];
  audit: ReturnType<typeof auditRecorder>;
};
const updateOwn = async ({
  minutes,
  organizationId = ids.orgA,
  audit,
}: OwnUpdateOptions) =>
  await updateMyDailyTarget.handler(
    asTestRaw<OwnContext>({
      body: { minutes },
      request: new Request("https://example.test/time-entries/me/daily-target"),
      route: "/time-entries/me/daily-target",
      safeDb: createSafeDb(db, [], organizationId, ids.userA1),
      session: { activeOrganizationId: organizationId },
      user: { id: ids.userA1 },
      memberRole: sessionMemberRole("member"),
      recordAuditEvent: audit.record,
    }),
  );

type MemberUpdateOptions = {
  minutes: number | null;
  targetUserId: TestIds["userA1"];
  actor: "member" | "owner" | "admin";
  audit: ReturnType<typeof auditRecorder>;
};
const updateMember = async ({
  minutes,
  targetUserId,
  actor,
  audit,
}: MemberUpdateOptions) => {
  const actorId = actor === "member" ? ids.userA1 : ids.userAdmin;
  return await updateMemberDailyTarget.handler(
    asTestRaw<MemberContext>({
      params: { userId: targetUserId },
      body: { minutes },
      request: new Request(
        "https://example.test/time-entries/members/daily-target",
      ),
      route: "/time-entries/members/:userId/daily-target",
      safeDb: createSafeDb(db, [], ids.orgA, actorId),
      session: { activeOrganizationId: ids.orgA },
      user: { id: actorId },
      memberRole: sessionMemberRole(actor),
      recordAuditEvent: audit.record,
    }),
  );
};
const readTarget = async ({
  organizationId,
  userId,
}: {
  organizationId: TestIds["orgA"];
  userId: TestIds["userA1"];
}) =>
  await db
    .select()
    .from(timeDailyTargets)
    .where(
      and(
        eq(timeDailyTargets.organizationId, organizationId),
        eq(timeDailyTargets.userId, userId),
      ),
    );

describe("daily target boundaries", () => {
  test("the request schema accepts only null or integer minute bounds", () => {
    for (const minutes of [null, 1, 1440]) {
      expect(Value.Check(dailyTargetBody, { minutes })).toBe(true);
    }
    for (const minutes of [0, -1, 1.5, 1441, "60"]) {
      expect(Value.Check(dailyTargetBody, { minutes })).toBe(false);
    }
  });

  test("persists both bounds and clearing for the signed-in member", async () => {
    const audit = auditRecorder();
    for (const minutes of [1, 1440, null]) {
      expect(await updateOwn({ minutes, audit })).toEqual({
        dailyTargetMinutes: minutes,
      });
      expect(
        await readTarget({ organizationId: ids.orgA, userId: ids.userA1 }),
      ).toMatchObject([{ minutes }]);
    }
    expect(audit.events).toHaveLength(3);
    expect(audit.events.map(({ resourceId }) => resourceId)).toEqual([
      ids.memberA1org,
      ids.memberA1org,
      ids.memberA1org,
    ]);
  });

  test("rejects invalid values even when called outside the HTTP schema", async () => {
    const audit = auditRecorder();
    for (const minutes of [0, -1, 1.5, 1441]) {
      expect(await updateOwn({ minutes, audit })).toMatchObject({
        code: 400,
        response: { code: "invalid_daily_target" },
      });
    }
    expect(
      await readTarget({ organizationId: ids.orgA, userId: ids.userA1 }),
    ).toEqual([]);
    expect(audit.events).toEqual([]);
  });
});

describe("daily target ownership and audit", () => {
  test("rejects another member's target for an ordinary member", async () => {
    const audit = auditRecorder();
    expect(
      await updateMember({
        minutes: 60,
        targetUserId: ids.userA2,
        actor: "member",
        audit,
      }),
    ).toMatchObject({
      code: 403,
      response: { code: "forbidden" },
    });
    expect(
      await readTarget({ organizationId: ids.orgA, userId: ids.userA2 }),
    ).toEqual([]);
    expect(audit.events).toEqual([]);
  });

  test("organization management can update a current member but cannot target a foreign member", async () => {
    const audit = auditRecorder();
    expect(
      await updateMember({
        minutes: 120,
        targetUserId: ids.userA2,
        actor: "owner",
        audit,
      }),
    ).toEqual({ dailyTargetMinutes: 120 });
    expect(
      await readTarget({ organizationId: ids.orgA, userId: ids.userA2 }),
    ).toMatchObject([{ minutes: 120 }]);
    expect(
      await updateMember({
        minutes: 60,
        targetUserId: ids.userB1,
        actor: "owner",
        audit,
      }),
    ).toMatchObject({
      code: 404,
      response: { code: "daily_target_member_not_found" },
    });
    expect(
      await readTarget({ organizationId: ids.orgB, userId: ids.userB1 }),
    ).toEqual([]);
    expect(audit.events).toHaveLength(1);
    expect(audit.events.at(0)?.resourceId).toBe(ids.memberA2org);
  });

  test("an administrator can update a current member's target", async () => {
    const audit = auditRecorder();
    await db
      .update(member)
      .set({ role: "owner" })
      .where(eq(member.id, ids.memberA1org));
    try {
      await db
        .update(member)
        .set({ role: "admin" })
        .where(eq(member.id, ids.memberAdminOrg));
      expect(
        await updateMember({
          minutes: 1440,
          targetUserId: ids.userA2,
          actor: "admin",
          audit,
        }),
      ).toEqual({ dailyTargetMinutes: 1440 });
      expect(
        await readTarget({ organizationId: ids.orgA, userId: ids.userA2 }),
      ).toMatchObject([{ minutes: 1440 }]);
      expect(audit.events).toHaveLength(1);
    } finally {
      await db
        .update(member)
        .set({ role: "owner" })
        .where(eq(member.id, ids.memberAdminOrg));
      await db
        .update(member)
        .set({ role: "member" })
        .where(eq(member.id, ids.memberA1org));
    }
  });

  test("keeps a user's targets separate across organizations and does not audit unchanged replay", async () => {
    const audit = auditRecorder();
    expect(await updateOwn({ minutes: 60, audit })).toEqual({
      dailyTargetMinutes: 60,
    });
    expect(
      await updateOwn({ minutes: 120, organizationId: ids.orgB, audit }),
    ).toEqual({ dailyTargetMinutes: 120 });
    expect(await updateOwn({ minutes: 60, audit })).toEqual({
      dailyTargetMinutes: 60,
    });
    expect(
      await readTarget({ organizationId: ids.orgA, userId: ids.userA1 }),
    ).toMatchObject([{ minutes: 60 }]);
    expect(
      await readTarget({ organizationId: ids.orgB, userId: ids.userA1 }),
    ).toMatchObject([{ minutes: 120 }]);
    expect(audit.events).toHaveLength(2);
    expect(await updateOwn({ minutes: null, audit })).toEqual({
      dailyTargetMinutes: null,
    });
    expect(await updateOwn({ minutes: null, audit })).toEqual({
      dailyTargetMinutes: null,
    });
    expect(audit.events).toHaveLength(3);
  });
});

describe("daily target row level security", () => {
  test("ordinary members can neither read nor update another member or another organization's target", async () => {
    await db.insert(timeDailyTargets).values([
      { organizationId: ids.orgA, userId: ids.userA1, minutes: 60 },
      { organizationId: ids.orgA, userId: ids.userA2, minutes: 120 },
      { organizationId: ids.orgB, userId: ids.userA1, minutes: 180 },
    ]);
    const safeDb = createSafeDb(db, [], ids.orgA, ids.userA1);
    const read = await safeDb(
      async (tx) => await tx.select().from(timeDailyTargets),
    );
    expect(Result.isOk(read)).toBe(true);
    expect(read.unwrap()).toMatchObject([
      { organizationId: ids.orgA, userId: ids.userA1, minutes: 60 },
    ]);
    expect(read.unwrap()).toHaveLength(1);
    for (const { organizationId, userId } of [
      { organizationId: ids.orgA, userId: ids.userA2 },
      { organizationId: ids.orgB, userId: ids.userA1 },
    ]) {
      const updated = await safeDb(
        async (tx) =>
          await tx
            .update(timeDailyTargets)
            .set({ minutes: 1 })
            .where(
              and(
                eq(timeDailyTargets.organizationId, organizationId),
                eq(timeDailyTargets.userId, userId),
              ),
            )
            .returning(),
      );
      expect(Result.isOk(updated)).toBe(true);
      expect(updated.unwrap()).toEqual([]);
      const deleted = await safeDb(
        async (tx) =>
          await tx
            .delete(timeDailyTargets)
            .where(
              and(
                eq(timeDailyTargets.organizationId, organizationId),
                eq(timeDailyTargets.userId, userId),
              ),
            )
            .returning(),
      );
      expect(Result.isError(deleted)).toBe(true);
      const inserted = await safeDb(
        async (tx) =>
          await tx
            .insert(timeDailyTargets)
            .values({ organizationId, userId, minutes: 1 })
            .onConflictDoUpdate({
              target: [
                timeDailyTargets.organizationId,
                timeDailyTargets.userId,
              ],
              set: { minutes: 1 },
            })
            .returning(),
      );
      expect(Result.isError(inserted)).toBe(true);
    }
    expect(
      await readTarget({ organizationId: ids.orgA, userId: ids.userA2 }),
    ).toMatchObject([{ minutes: 120 }]);
    expect(
      await readTarget({ organizationId: ids.orgB, userId: ids.userA1 }),
    ).toMatchObject([{ minutes: 180 }]);
  });
});
