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
import { and, eq, inArray, sql } from "drizzle-orm";
import { boolean, integer, pgTable, text } from "drizzle-orm/pg-core";

import { member, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { absences, auditLogs } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { anonymizeAbsenceHistory } from "@/api/lib/account-deletion-steps";
import { AUDIT_ACTION, createAuditRecorder } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import approvalQueue from "./approval-queue/list";
import approve from "./approve";
import cancel from "./cancel";
import mine from "./mine/list";
import reject from "./reject";
import request from "./request";

type RequestCtx = Parameters<typeof request.handler>[0];
type ApproveCtx = Parameters<typeof approve.handler>[0];
type RejectCtx = Parameters<typeof reject.handler>[0];
type CancelCtx = Parameters<typeof cancel.handler>[0];
type MineCtx = Parameters<typeof mine.handler>[0];
type QueueCtx = Parameters<typeof approvalQueue.handler>[0];
setDefaultTimeout(120_000);
let db: TestDatabase;
let ids: TestIds;
const pgLocks = pgTable("pg_locks", {
  pid: integer("pid"),
  locktype: text("locktype"),
  granted: boolean("granted"),
  mode: text("mode"),
});
const createdIds: SafeId<"absence">[] = [];
const BODY = {
  kind: "vacation",
  startDate: "2026-10-01",
  endDate: "2026-10-03",
  timezoneId: "Europe/Prague",
  coverage: { type: "full" },
} satisfies RequestCtx["body"];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  db = fixture.testDb;
  ids = fixture.ids;
});
const cleanup = async () => {
  if (!createdIds.length) {
    return;
  }
  await db.delete(auditLogs).where(inArray(auditLogs.resourceId, createdIds));
  await db.delete(absences).where(inArray(absences.id, createdIds.splice(0)));
};
beforeEach(cleanup);
afterAll(async () => {
  try {
    await cleanup();
  } finally {
    await releaseRlsFixture();
  }
});
const context = (actor = ids.userA1, role: "member" | "owner" = "member") => {
  const req = new Request("https://example.test/absences");
  return {
    request: req,
    route: "/v1/absences",
    session: { activeOrganizationId: ids.orgA },
    user: { id: actor },
    memberRole: { role },
    safeDb: createSafeDb(db, [], ids.orgA, actor),
    recordAuditEvent: createAuditRecorder({
      organizationId: ids.orgA,
      userId: actor,
      workspaceId: null,
      request: req,
      server: null,
    }),
  };
};
const requestFor = async (
  body: RequestCtx["body"] = BODY,
  actor = ids.userA1,
) => {
  const result = await request.handler(
    asTestRaw<RequestCtx>({ ...context(actor), body }),
  );
  if (!("id" in result)) {
    throw new Error(`request failed: ${JSON.stringify(result)}`);
  }
  createdIds.push(result.id);
  return result;
};
const approveFor = async (
  id: SafeId<"absence">,
  version = 1,
  actor = ids.userAdmin,
) =>
  await approve.handler(
    asTestRaw<ApproveCtx>({
      ...context(actor, actor === ids.userAdmin ? "owner" : "member"),
      params: { id },
      body: { version },
    }),
  );
const mineFor = async (query: MineCtx["query"] = {}, actor = ids.userA1) =>
  await mine.handler(asTestRaw<MineCtx>({ ...context(actor), query }));
const queueFor = async (actor = ids.userAdmin) =>
  await approvalQueue.handler(
    asTestRaw<QueueCtx>({
      ...context(actor, actor === ids.userAdmin ? "owner" : "member"),
      query: {},
    }),
  );
const stored = async (id: SafeId<"absence">) =>
  await db.query.absences.findFirst({ where: { id: { eq: id } } });
const seed = async (organizationId = ids.orgA, userId = ids.userA1) => {
  const id = createSafeId<"absence">();
  await db.insert(absences).values({
    id,
    organizationId,
    userId,
    kind: "vacation",
    startDate: BODY.startDate,
    endDate: BODY.endDate,
    timezoneId: BODY.timezoneId,
    coverage: "full",
  });
  createdIds.push(id);
  return id;
};

describe("absence ownership and pages", () => {
  test("requests bind actor and organization and list days without assumed minutes", async () => {
    const full = await requestFor();
    const half = await requestFor({
      ...BODY,
      endDate: "2026-10-02",
      coverage: { type: "half", segment: "morning" },
    });
    await requestFor(BODY, ids.userA2);
    await seed(ids.orgB, ids.userA1);
    expect(full).toMatchObject({ status: "requested", version: 1 });
    expect(await stored(full.id)).toMatchObject({
      userId: ids.userA1,
      organizationId: ids.orgA,
      halfDaySegment: null,
    });
    const first = await mineFor({ limit: 1 });
    if (!("items" in first) || !first.nextCursor) {
      throw new Error("expected first absence page");
    }
    const second = await mineFor({ limit: 1, cursor: first.nextCursor });
    if (!("items" in second)) {
      throw new Error("expected second absence page");
    }
    expect(second.nextCursor).toBeNull();
    const items = [...first.items, ...second.items];
    expect(items.map(({ id }) => id).toSorted()).toEqual(
      [full.id, half.id].toSorted(),
    );
    expect(items.find(({ id }) => id === full.id)?.days).toBe(2);
    expect(items.find(({ id }) => id === half.id)?.days).toBe(0.5);
    expect(await queueFor(ids.userA1)).toMatchObject({ code: 403 });
    const queue = await queueFor();
    if (!("items" in queue)) {
      throw new Error("expected manager queue");
    }
    expect(queue.items).toHaveLength(3);
    const logs = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, full.id));
    expect(logs.at(0)).toMatchObject({
      action: AUDIT_ACTION.CREATE,
      userId: ids.userA1,
      organizationId: ids.orgA,
      workspaceId: null,
    });
  });

  test("another member and another tenant cannot read, update, or decide the supplied absence", async () => {
    const own = await requestFor();
    const foreign = await seed(ids.orgB, ids.userB1);
    expect(await mineFor({}, ids.userA2)).toMatchObject({ items: [] });
    expect(await approveFor(own.id, 1, ids.userA2)).toMatchObject({
      code: 403,
    });
    expect(await approveFor(foreign)).toMatchObject({ code: 404 });
    const scoped = createScopedDb(db, [], ids.orgA, ids.userA2);
    expect(
      await scoped(
        async (tx) =>
          await tx
            .update(absences)
            .set({ kind: "other" })
            .where(inArray(absences.id, [own.id, foreign]))
            .returning(),
      ),
    ).toEqual([]);
    const moving = await Result.tryPromise(
      async () =>
        await createScopedDb(
          db,
          [],
          ids.orgA,
          ids.userA1,
        )(
          async (tx) =>
            await tx
              .update(absences)
              .set({ organizationId: ids.orgB })
              .where(eq(absences.id, own.id)),
        ),
    );
    expect(moving.isErr()).toBe(true);
    if (moving.isErr()) {
      expect(isPgError(moving.error, PG_ERROR.INSUFFICIENT_PRIVILEGE)).toBe(
        true,
      );
    }
    expect((await stored(own.id))?.status).toBe("requested");
    expect((await stored(foreign))?.status).toBe("requested");
  });
});

describe("absence decisions", () => {
  test("cancelling requires ownership and requested state; stale versions never change a decision", async () => {
    const own = await requestFor();
    const other = await requestFor(BODY, ids.userA2);
    expect(
      await cancel.handler(
        asTestRaw<CancelCtx>({
          ...context(),
          params: { id: other.id },
          body: { version: 1 },
        }),
      ),
    ).toMatchObject({ code: 404 });
    expect(
      await cancel.handler(
        asTestRaw<CancelCtx>({
          ...context(),
          params: { id: own.id },
          body: { version: 1 },
        }),
      ),
    ).toEqual({ id: own.id, status: "cancelled", version: 2 });
    expect(await stored(own.id)).toMatchObject({
      decidedAt: expect.any(Date),
      approverUserId: null,
    });
    expect(await approveFor(own.id, 2)).toMatchObject({ code: 409 });
    const fresh = await requestFor({
      ...BODY,
      startDate: "2026-10-04",
      endDate: "2026-10-05",
    });
    expect(await approveFor(fresh.id, 2)).toMatchObject({ code: 409 });
    expect(await approveFor(fresh.id)).toEqual({
      id: fresh.id,
      status: "approved",
      version: 2,
    });
    expect(
      await cancel.handler(
        asTestRaw<CancelCtx>({
          ...context(),
          params: { id: fresh.id },
          body: { version: 2 },
        }),
      ),
    ).toMatchObject({ code: 409 });
    const logs = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, fresh.id));
    expect(logs).toHaveLength(2);
    expect(
      logs.find(({ action }) => action === AUDIT_ACTION.UPDATE),
    ).toMatchObject({ userId: ids.userAdmin, workspaceId: null });
  });

  test("rejection requires nonblank feedback and records the manager's decision", async () => {
    const entry = await requestFor();
    for (const comment of ["", "  ", "\t\n"]) {
      expect(
        await reject.handler(
          asTestRaw<RejectCtx>({
            ...context(ids.userAdmin, "owner"),
            params: { id: entry.id },
            body: { version: 1, comment },
          }),
        ),
      ).toMatchObject({ code: 400 });
    }
    expect(
      await reject.handler(
        asTestRaw<RejectCtx>({
          ...context(ids.userAdmin, "owner"),
          params: { id: entry.id },
          body: { version: 1, comment: "Please use the agreed dates" },
        }),
      ),
    ).toEqual({ id: entry.id, status: "rejected", version: 2 });
    expect(await stored(entry.id)).toMatchObject({
      approverUserId: ids.userAdmin,
      decidedAt: expect.any(Date),
      decisionComment: "Please use the agreed dates",
    });
  });

  test("serialized approval refuses overlapping ranges but allows adjacent days and opposite half-days", async () => {
    const first = await requestFor();
    const overlapping = await requestFor({
      ...BODY,
      startDate: "2026-10-02",
      endDate: "2026-10-04",
    });
    const adjacent = await requestFor({
      ...BODY,
      startDate: "2026-10-03",
      endDate: "2026-10-04",
    });
    let heldOwnerLock = false;
    let heldMembershipLock = false;
    const admin = context(ids.userAdmin, "owner");
    const record: AuditRecorder = async (tx, event) => {
      const held = await tx
        .select({ granted: pgLocks.granted })
        .from(pgLocks)
        .where(
          and(
            eq(pgLocks.pid, sql`pg_backend_pid()`),
            eq(pgLocks.locktype, "advisory"),
            eq(pgLocks.granted, true),
            sql`objid = (hashtext(${`absence:${ids.orgA}:${ids.userA1}`})::bigint & 4294967295)::oid`,
          ),
        );
      heldOwnerLock = held.length > 0;
      const membershipLock = await tx
        .select({ granted: pgLocks.granted })
        .from(pgLocks)
        .where(
          and(
            eq(pgLocks.pid, sql`pg_backend_pid()`),
            eq(pgLocks.granted, true),
            eq(pgLocks.mode, "RowShareLock"),
            sql`relation = 'member'::regclass`,
          ),
        );
      heldMembershipLock = membershipLock.length > 0;
      await admin.recordAuditEvent(tx, event);
    };
    expect(
      await approve.handler(
        asTestRaw<ApproveCtx>({
          ...admin,
          recordAuditEvent: record,
          params: { id: first.id },
          body: { version: 1 },
        }),
      ),
    ).toMatchObject({ status: "approved" });
    expect(heldOwnerLock).toBe(true);
    expect(heldMembershipLock).toBe(true);
    expect(await approveFor(overlapping.id)).toMatchObject({
      code: 409,
      response: { message: expect.stringContaining("overlaps") },
    });
    expect((await stored(overlapping.id))?.status).toBe("requested");
    expect(await approveFor(adjacent.id)).toMatchObject({ status: "approved" });
    const morning = await requestFor({
      ...BODY,
      startDate: "2026-10-05",
      endDate: "2026-10-06",
      coverage: { type: "half", segment: "morning" },
    });
    const afternoon = await requestFor({
      ...BODY,
      startDate: "2026-10-05",
      endDate: "2026-10-06",
      coverage: { type: "half", segment: "afternoon" },
    });
    const duplicateMorning = await requestFor({
      ...BODY,
      startDate: "2026-10-05",
      endDate: "2026-10-06",
      coverage: { type: "half", segment: "morning" },
    });
    expect(await approveFor(morning.id)).toMatchObject({ status: "approved" });
    expect(await approveFor(afternoon.id)).toMatchObject({
      status: "approved",
    });
    expect(await approveFor(duplicateMorning.id)).toMatchObject({ code: 409 });
  });
});

describe("absence calendar constraints", () => {
  const invalid = [
    { label: "empty range", change: { endDate: "2026-10-01" } },
    { label: "reversed range", change: { endDate: "2026-09-30" } },
    {
      label: "multi-day half",
      change: { coverage: "half", halfDaySegment: "morning" },
    },
    {
      label: "half without segment",
      change: { coverage: "half", endDate: "2026-10-02" },
    },
    { label: "full with segment", change: { halfDaySegment: "afternoon" } },
    { label: "nonpositive version", change: { version: 0 } },
    {
      label: "requested decision timestamp",
      change: { decidedAt: new Date("2026-10-01T00:00:00Z") },
    },
    { label: "requested comment", change: { decisionComment: "Decision" } },
    { label: "approved without decision time", change: { status: "approved" } },
    { label: "rejected without decision time", change: { status: "rejected" } },
    {
      label: "cancelled without decision time",
      change: { status: "cancelled" },
    },
    {
      label: "blank terminal comment",
      change: {
        status: "approved",
        decidedAt: new Date("2026-10-01T00:00:00Z"),
        decisionComment: " ",
      },
    },
    {
      label: "oversized terminal comment",
      change: {
        status: "approved",
        decidedAt: new Date("2026-10-01T00:00:00Z"),
        decisionComment: "x".repeat(2001),
      },
    },
  ] satisfies {
    label: string;
    change: Partial<typeof absences.$inferInsert>;
  }[];
  test.each(invalid)("rejects $label in the database", async ({ change }) => {
    const id = await seed();
    const outcome = await Result.tryPromise(
      async () =>
        await db.transaction(
          async (tx) =>
            await tx.update(absences).set(change).where(eq(absences.id, id)),
        ),
    );
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(isPgError(outcome.error, "23514")).toBe(true);
    }
    expect(await stored(id)).toMatchObject({
      startDate: BODY.startDate,
      endDate: BODY.endDate,
      coverage: "full",
      status: "requested",
      version: 1,
    });
  });
});

test("an optional blank approval comment is normalized to no comment", async () => {
  const entry = await requestFor();
  expect(
    await approve.handler(
      asTestRaw<ApproveCtx>({
        ...context(ids.userAdmin, "owner"),
        params: { id: entry.id },
        body: { version: 1, comment: "   " },
      }),
    ),
  ).toMatchObject({ status: "approved" });
  expect((await stored(entry.id))?.decisionComment).toBeNull();
});

test("erasing a departed owner retains anonymized decisions and denies later requests", async () => {
  const ownerId = mintAuthProviderId<"user">();
  const memberId = mintAuthProviderIdValue();
  await db.insert(user).values({
    id: ownerId,
    name: "Absence owner",
    email: `${ownerId}@test.local`,
  });
  await db.insert(member).values({
    id: memberId,
    organizationId: ids.orgA,
    userId: ownerId,
    role: "member",
    createdAt: new Date(),
  });
  try {
    const entry = await requestFor(BODY, ownerId);
    expect(await approveFor(entry.id)).toMatchObject({ status: "approved" });
    await db.delete(member).where(eq(member.id, memberId));
    const refused = await request.handler(
      asTestRaw<RequestCtx>({ ...context(ownerId), body: BODY }),
    );
    expect(refused).toMatchObject({ code: 403 });
    await db.delete(user).where(eq(user.id, ownerId));
    expect(await stored(entry.id)).toMatchObject({
      userId: null,
      status: "approved",
      approverUserId: ids.userAdmin,
      decidedAt: expect.any(Date),
    });
    const history = await createSafeDb(
      db,
      [],
      ids.orgA,
      ids.userAdmin,
    )(
      async (tx) =>
        await tx
          .select({ id: absences.id, userId: absences.userId })
          .from(absences)
          .where(eq(absences.id, entry.id)),
    );
    expect(history.isOk() && history.value).toEqual([
      { id: entry.id, userId: null },
    ]);
  } finally {
    await db.delete(member).where(eq(member.id, memberId));
    await db.delete(user).where(eq(user.id, ownerId));
  }
});

test("invalid date ranges and half-day requests fail before insertion", async () => {
  const invalidBodies = [
    { ...BODY, endDate: BODY.startDate },
    { ...BODY, startDate: "2026-02-30" },
    { ...BODY, coverage: { type: "half", segment: "morning" } },
    { ...BODY, timezoneId: "Not/A_Timezone" },
  ] satisfies RequestCtx["body"][];
  for (const body of invalidBodies) {
    expect(
      await request.handler(asTestRaw<RequestCtx>({ ...context(), body })),
    ).toMatchObject({ code: 400 });
  }
  expect(createdIds).toHaveLength(0);
});

describe("absence domain values", () => {
  test.each(["kind", "coverage", "half_day_segment", "status"])(
    "rejects an unknown %s at the SQL boundary",
    async (column) => {
      const id = await seed();
      const outcome = await Result.tryPromise(
        async () =>
          await db.transaction(
            async (tx) =>
              await tx.execute(
                sql`UPDATE ${absences} SET ${sql.identifier(column)} = 'invalid' WHERE ${absences.id} = ${id}`,
              ),
          ),
      );
      expect(outcome.isErr()).toBe(true);
      if (outcome.isErr()) {
        expect(isPgError(outcome.error, "23514")).toBe(true);
      }
      expect((await stored(id))?.status).toBe("requested");
    },
  );
});

test("the account-erasure operation anonymizes subject and decision actor while retaining history", async () => {
  const subject = await seed();
  const actor = await seed(ids.orgA, ids.userA2);
  const decidedAt = new Date("2026-10-01T12:00:00Z");
  await db
    .update(absences)
    .set({
      status: "approved",
      approverUserId: ids.userAdmin,
      decidedAt,
      version: 2,
    })
    .where(eq(absences.id, subject));
  await db
    .update(absences)
    .set({
      status: "approved",
      approverUserId: ids.userA1,
      decidedAt,
      version: 2,
    })
    .where(eq(absences.id, actor));
  await db.transaction(
    async (tx) =>
      await anonymizeAbsenceHistory(asTestRaw<Transaction>(tx), ids.userA1),
  );
  expect(await stored(subject)).toMatchObject({
    userId: null,
    approverUserId: ids.userAdmin,
    status: "approved",
    version: 2,
    decidedAt,
    kind: "vacation",
    startDate: BODY.startDate,
    endDate: BODY.endDate,
    coverage: "full",
  });
  expect(await stored(actor)).toMatchObject({
    userId: ids.userA2,
    approverUserId: null,
    status: "approved",
    version: 2,
    decidedAt,
    kind: "vacation",
    startDate: BODY.startDate,
    endDate: BODY.endDate,
    coverage: "full",
  });
  await db.transaction(
    async (tx) =>
      await anonymizeAbsenceHistory(asTestRaw<Transaction>(tx), ids.userA1),
  );
  expect((await stored(actor))?.approverUserId).toBeNull();
  expect((await stored(subject))?.userId).toBeNull();
  expect(
    await db.select({ id: user.id }).from(user).where(eq(user.id, ids.userA1)),
  ).toEqual([{ id: ids.userA1 }]);
});
