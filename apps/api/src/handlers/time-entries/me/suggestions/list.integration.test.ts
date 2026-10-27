import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  auditLogs,
  chatMessages,
  chatThreads,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import {
  queryCountLogger,
  runWithMeasuredQueryCounter,
} from "@/api/lib/db-query-counter";
import { LIMITS } from "@/api/lib/limits";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { withTimeBillingEnrolment } from "@/api/tests/helpers/time-billing-enrolment";
import { readScalingViolations } from "@/api/tests/read-scaling/measurement";
import {
  seedSuggestionRangeScaling,
  suggestionRangeScalingScenario,
} from "@/api/tests/read-scaling/time-suggestion-range";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import {
  type TestDatabase,
  withQueryLogger,
} from "@/api/tests/security/test-utils";

import listMySuggestionRange from "./list";

type ListCtx = Parameters<typeof listMySuggestionRange.handler>[0];

// A fixed past week, clear of the rows the shared fixture stamps with its own
// creation time.
const MONDAY = "2019-03-04";
const TUESDAY = "2019-03-05";
const SUNDAY = "2019-03-10";
const NEXT_MONDAY = "2019-03-11";
const TIMEZONE = "UTC";
const at = (date: string, time: string) => new Date(`${date}T${time}Z`);

/** Matters in the same organization the timekeeper is not a member of. */
const hiddenMatterId = createSafeId<"workspace">();
const extraMatterIds = Array.from({ length: 10 }, () =>
  createSafeId<"workspace">(),
);
const threadId = createSafeId<"chatThread">();
const messageId = createSafeId<"chatMessage">();
const auditIds: SafeId<"auditLog">[] = [];

let testDb: TestDatabase;
let ids: TestIds;

type SeedAuditOptions = {
  workspaceId: SafeId<"workspace">;
  createdAt: Date;
};

// Rows go through the real recorder so derived columns match production;
// only the timestamp is moved afterwards, onto the day under test.
const seedAuditRow = async ({ workspaceId, createdAt }: SeedAuditOptions) => {
  const resourceId = createSafeId<"entity">();
  const record = createBackgroundAuditRecorder({
    organizationId: ids.orgA,
    workspaceId,
    userId: ids.userA1,
    execution: {
      performer: { type: "user", id: ids.userA1 },
      trigger: { type: "direct" },
    },
  });
  await testDb.transaction(async (tx) => {
    await record(asTestRaw<Transaction>(tx), {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
      resourceId,
    });
  });
  const [row] = await testDb
    .update(auditLogs)
    .set({ createdAt })
    .where(
      and(
        eq(auditLogs.workspaceId, workspaceId),
        eq(auditLogs.resourceId, resourceId),
      ),
    )
    .returning({ id: auditLogs.id });
  if (!row) {
    throw new Error("audit row was not recorded");
  }
  auditIds.push(row.id);
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;

  await testDb.insert(workspaces).values(
    [hiddenMatterId, ...extraMatterIds].map((id, index) => ({
      id,
      organizationId: ids.orgA,
      clientId: ids.contactA,
      name: `Unlisted matter ${index}`,
      reference: `TEST-${id}`,
    })),
  );
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    userId: ids.userA1,
    workspaceId: ids.wsA2,
    title: "Supply agreement",
  });
  await testDb.insert(chatMessages).values({
    id: messageId,
    threadId,
    workspaceId: ids.wsA2,
    userId: ids.userA1,
    role: "user",
    content: toPersistedChatMessageContentV3({
      data: [{ type: "text" as const, content: "Draft the indemnity" }],
    }),
    createdAt: at(TUESDAY, "10:00:00"),
  });
  await Promise.all([
    seedAuditRow({ workspaceId: ids.wsA1, createdAt: at(MONDAY, "09:00:00") }),
    // Outside the range: the next week's activity never leaks in.
    seedAuditRow({
      workspaceId: ids.wsA1,
      createdAt: at(NEXT_MONDAY, "09:00:00"),
    }),
    seedAuditRow({
      workspaceId: hiddenMatterId,
      createdAt: at(MONDAY, "11:00:00"),
    }),
    ...extraMatterIds.map((workspaceId) =>
      seedAuditRow({ workspaceId, createdAt: at(MONDAY, "15:00:00") }),
    ),
  ]);
});

afterAll(async () => {
  try {
    await testDb.delete(auditLogs).where(inArray(auditLogs.id, auditIds));
    await testDb.delete(chatMessages).where(eq(chatMessages.id, messageId));
    await testDb.delete(chatThreads).where(eq(chatThreads.id, threadId));
    await testDb
      .delete(workspaces)
      .where(inArray(workspaces.id, [hiddenMatterId, ...extraMatterIds]));
  } finally {
    await releaseRlsFixture();
  }
});

type ListOptions = {
  startDate: string;
  endDate: string;
  matters?: SafeId<"workspace">[];
  database?: TestDatabase;
};

const listFor = async ({
  startDate,
  endDate,
  matters = [ids.wsA1, ids.wsA2],
  database = testDb,
}: ListOptions) =>
  await listMySuggestionRange.handler(
    withTimeBillingEnrolment(
      asTestRaw<ListCtx>({
        query: { startDate, endDate, timezoneId: TIMEZONE },
        request: new Request(
          "https://example.test/time-entries/me/suggestions",
        ),
        route: "/time-entries/me/suggestions",
        // The scoped transaction and the request's matter authorization agree,
        // as they do in production: the timekeeper belongs to these matters.
        safeDb: createSafeDb(database, matters, ids.orgA, ids.userA1),
        getActiveWorkspaceIds: async () => matters,
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userA1 },
        memberRole: sessionMemberRole("member"),
      }),
    ),
  );

type RangeResponse = {
  startDate: string;
  endDate: string;
  days: {
    date: string;
    matters: {
      matter: { id: string; name: string; reference: string };
      activeMinutes: number;
      items: { fingerprint: string; durationMinutes: number }[];
    }[];
  }[];
};

const isRangeResponse = (value: unknown): value is RangeResponse =>
  typeof value === "object" &&
  value !== null &&
  "days" in value &&
  Array.isArray(value.days);

const expectRange = async (options: ListOptions) => {
  const response = await listFor(options);
  if (!isRangeResponse(response)) {
    throw new Error(`unexpected range response: ${JSON.stringify(response)}`);
  }
  return response;
};

const matterIdsByDay = (response: RangeResponse) =>
  response.days.map(({ date, matters }) => ({
    date,
    matters: matters.map(({ matter }) => matter.id),
  }));

describe("my suggestion range", () => {
  test("returns each day's suggestions grouped by matter across matters", async () => {
    const response = await expectRange({
      startDate: MONDAY,
      endDate: TUESDAY,
    });

    expect(matterIdsByDay(response)).toEqual([
      { date: MONDAY, matters: [ids.wsA1] },
      { date: TUESDAY, matters: [ids.wsA2] },
    ]);
    const [monday, tuesday] = response.days;
    expect(monday?.matters[0]?.matter).toEqual({
      id: ids.wsA1,
      name: "WS A1",
      reference: "REF-A1",
    });
    expect(tuesday?.matters[0]).toMatchObject({
      matter: { id: ids.wsA2, name: "WS A2" },
      items: [
        {
          signalCount: 1,
          evidence: [
            {
              type: "chat_thread",
              title: "Supply agreement",
              signals: [{ source: "chat_message", resourceId: messageId }],
            },
          ],
        },
      ],
    });
    for (const day of response.days) {
      for (const group of day.matters) {
        expect(group.items).toHaveLength(1);
        expect(group.activeMinutes).toBe(group.items[0]?.durationMinutes);
      }
    }
  });

  test("never returns a matter the timekeeper cannot read, even though its audit rows are visible to the organization", async () => {
    // The fixture must reach the boundary: row-level security alone lets the
    // timekeeper's scoped transaction read the unlisted matter's audit row,
    // so only the range loader's matter filter keeps it out.
    const visibleToOrganization = await createSafeDb(
      testDb,
      [ids.wsA1, ids.wsA2],
      ids.orgA,
      ids.userA1,
    )((tx) =>
      tx
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(eq(auditLogs.workspaceId, hiddenMatterId)),
    );
    expect(visibleToOrganization.unwrap()).toHaveLength(1);

    const response = await expectRange({
      startDate: MONDAY,
      endDate: SUNDAY,
    });
    const listed = matterIdsByDay(response).flatMap(({ matters }) => matters);
    expect(listed.length).toBeGreaterThan(0);
    expect(new Set(listed)).toEqual(new Set([ids.wsA1, ids.wsA2]));
    expect(JSON.stringify(response)).not.toContain(hiddenMatterId);
  });

  test("covers at most seven days", async () => {
    expect(await listFor({ startDate: MONDAY, endDate: SUNDAY })).toSatisfy(
      isRangeResponse,
    );
    for (const endDate of [NEXT_MONDAY, "2019-03-03"]) {
      expect(await listFor({ startDate: MONDAY, endDate })).toMatchObject({
        code: 400,
        response: { code: "invalid_date_range" },
      });
    }
  });

  test("offers a busy day the same suggestions in a week read as in its one-day decision read", async () => {
    // A separate week: the day's first source cap of signals forms a morning
    // cluster and one more signal an evening cluster beyond the cap.
    const busyMonday = "2019-04-01";
    const morningResourceIds = Array.from(
      { length: LIMITS.timeSuggestionSignalsPerSourceMax },
      () => createSafeId<"entity">(),
    );
    const record = createBackgroundAuditRecorder({
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      execution: {
        performer: { type: "user", id: ids.userA1 },
        trigger: { type: "direct" },
      },
    });
    await testDb.transaction(async (tx) => {
      await record(
        asTestRaw<Transaction>(tx),
        morningResourceIds.map((resourceId) => ({
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
          resourceId,
        })),
      );
    });
    const morning = await testDb
      .update(auditLogs)
      .set({ createdAt: at(busyMonday, "08:00:00") })
      .where(
        and(
          eq(auditLogs.workspaceId, ids.wsA1),
          inArray(auditLogs.resourceId, morningResourceIds),
        ),
      )
      .returning({ id: auditLogs.id });
    auditIds.push(...morning.map(({ id }) => id));
    expect(morning).toHaveLength(LIMITS.timeSuggestionSignalsPerSourceMax);
    await seedAuditRow({
      workspaceId: ids.wsA1,
      createdAt: at(busyMonday, "20:00:00"),
    });

    const suggestionsOn = (response: RangeResponse) =>
      response.days
        .filter(({ date }) => date === busyMonday)
        .flatMap(({ matters }) => matters)
        .filter(({ matter }) => matter.id === ids.wsA1)
        .flatMap(({ items }) =>
          items.map(({ fingerprint, durationMinutes }) => ({
            fingerprint,
            durationMinutes,
          })),
        );
    const week = await expectRange({
      startDate: busyMonday,
      endDate: "2019-04-07",
      matters: [ids.wsA1],
    });
    const day = await expectRange({
      startDate: busyMonday,
      endDate: busyMonday,
      matters: [ids.wsA1],
    });

    expect(suggestionsOn(day)).toHaveLength(1);
    expect(suggestionsOn(week)).toEqual(suggestionsOn(day));
  });

  test("issues the same statements for two matters as for twelve", async () => {
    const counted = withQueryLogger(testDb, queryCountLogger);
    const measure = async (matters: SafeId<"workspace">[]) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await expectRange({
          startDate: MONDAY,
          endDate: SUNDAY,
          matters,
          database: counted,
        });
        return {
          statements: counter.count,
          matters: response.days.flatMap((day) => day.matters).length,
        };
      });

    const few = await measure([ids.wsA1, ids.wsA2]);
    const many = await measure([ids.wsA1, ids.wsA2, ...extraMatterIds]);
    expect(few.matters).toBe(2);
    expect(many.matters).toBe(12);
    expect(few.statements).toBeGreaterThan(0);
    expect(many.statements).toBe(few.statements);
  });

  test("pays the same round trips with 10 or 200 accessible matters for a fixed week of work", async () => {
    const seed = async (size: number) =>
      await seedSuggestionRangeScaling(testDb, {
        organizationId: ids.orgA,
        clientId: ids.contactA,
        userId: ids.userA1,
        size,
      });
    const small = await seed(10);
    const large = await seed(200);
    try {
      const at10 = await suggestionRangeScalingScenario.measure(small);
      const at200 = await suggestionRangeScalingScenario.measure(large);
      expect(at10.rows).toBe(10);
      expect(at200.rows).toBe(10);
      expect(at10.statements).toBeGreaterThan(0);
      expect(readScalingViolations({ small: at10, large: at200 })).toEqual([]);
    } finally {
      await small.cleanup();
      await large.cleanup();
    }
  });
});
