import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, desc, eq, inArray } from "drizzle-orm";

import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import {
  auditLogs,
  chatMessages,
  chatThreads,
  timeEntries,
  timeEntrySuggestions,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import type { AuditAction, AuditResourceType } from "@/api/lib/audit-log";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { brandPersistedTimeEntryId } from "@/api/lib/safe-id-boundaries";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import createTimeSuggestionDecision from "./decisions/create";
import listTimeSuggestions from "./list";

setDefaultTimeout(120_000);

type ListCtx = Parameters<typeof listTimeSuggestions.handler>[0];
type DecisionCtx = Parameters<typeof createTimeSuggestionDecision.handler>[0];

let testDb: TestDatabase;
let ids: TestIds;

// Yesterday in UTC: inside the entry age window, and clear of the fixture's
// own chat rows, which are stamped at fixture creation time (today).
const DAY = Temporal.Now.plainDateISO("UTC").subtract({ days: 1 }).toString();
const TIMEZONE = "UTC";
const at = (time: string) => new Date(`${DAY}T${time}Z`);

const threadId = createSafeId<"chatThread">();
const messageIds = [
  createSafeId<"chatMessage">(),
  createSafeId<"chatMessage">(),
  createSafeId<"chatMessage">(),
];
const auditIds: SafeId<"auditLog">[] = [];

type SeedAuditRowOptions = {
  userId: SafeId<"user">;
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId: string;
  createdAt: Date;
};

// Rows go through the real recorder so derived columns match production;
// only the timestamp is moved afterwards, onto the day under test.
const seedAuditRow = async ({
  userId,
  action,
  resourceType,
  resourceId,
  createdAt,
}: SeedAuditRowOptions) => {
  const record = createBackgroundAuditRecorder({
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    userId,
    execution: {
      performer: { type: "user", id: userId },
      trigger: { type: "direct" },
    },
  });
  await testDb.transaction(async (tx) => {
    await record(asTestRaw<Transaction>(tx), {
      action,
      resourceType,
      resourceId,
    });
  });
  const [row] = await testDb
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.workspaceId, ids.wsA1),
        eq(auditLogs.userId, userId),
        eq(auditLogs.resourceType, resourceType),
        eq(auditLogs.resourceId, resourceId),
      ),
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(1);
  if (!row) {
    throw new Error("audit row was not recorded");
  }
  await testDb
    .update(auditLogs)
    .set({ createdAt })
    .where(eq(auditLogs.id, row.id));
  auditIds.push(row.id);
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;

  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    userId: ids.userA1,
    workspaceId: ids.wsA1,
    title: "Lease negotiation",
  });
  const content = (text: string) => ({
    version: 1 as const,
    data: [{ type: "text" as const, text }],
  });
  await testDb.insert(chatMessages).values([
    {
      id: messageIds[0],
      threadId,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      role: "user",
      content: content("first"),
      createdAt: at("09:00:00"),
    },
    {
      id: messageIds[1],
      threadId,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      role: "user",
      content: content("second"),
      createdAt: at("09:08:00"),
    },
    {
      id: messageIds[2],
      threadId,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      role: "user",
      content: content("afternoon"),
      createdAt: at("14:00:00"),
    },
  ]);
  await seedAuditRow({
    userId: ids.userA1,
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
    resourceId: ids.entityA1,
    createdAt: at("09:15:00"),
  });
  // Billing bookkeeping is never activity to suggest from.
  await seedAuditRow({
    userId: ids.userA1,
    action: AUDIT_ACTION.CREATE,
    resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
    resourceId: createSafeId<"timeEntry">(),
    createdAt: at("11:00:00"),
  });
  // Another timekeeper's work in the same matter stays theirs.
  await seedAuditRow({
    userId: ids.userA2,
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
    resourceId: ids.entityA1,
    createdAt: at("12:00:00"),
  });
});

afterAll(async () => {
  try {
    await testDb
      .delete(timeEntrySuggestions)
      .where(eq(timeEntrySuggestions.userId, ids.userA1));
    await testDb.delete(timeEntries).where(eq(timeEntries.source, "suggested"));
    await testDb.delete(auditLogs).where(inArray(auditLogs.id, auditIds));
    await testDb
      .delete(chatMessages)
      .where(inArray(chatMessages.id, messageIds));
    await testDb.delete(chatThreads).where(eq(chatThreads.id, threadId));
  } finally {
    await releaseRlsFixture();
  }
});

const baseContext = (userId: SafeId<"user">) => ({
  getActiveWorkspaceIds: async () => [ids.wsA1],
  getAccessibleWorkspaces: async () => [{ id: ids.wsA1, status: "active" }],
  getWorkspaceAccess: async () => ({ id: ids.wsA1, status: "active" }),
  createAuditRecorder: () => async () => {},
  memberRole: { role: "owner" },
  orgAIConfig: null,
  params: { workspaceId: ids.wsA1 },
  promptCachingEnabled: false,
  recordAuditEvent: async () => {},
  request: new Request(`https://example.test/workspaces/${ids.wsA1}`),
  route: "/test/time-entries/suggestions",
  safeDb: createSafeDb(testDb, [ids.wsA1], ids.orgA, userId),
  scopedDb: createScopedDb(testDb, [ids.wsA1], ids.orgA, userId),
  session: { activeOrganizationId: ids.orgA },
  user: { id: userId },
  workspaceId: ids.wsA1,
});

const listFor = async (userId: SafeId<"user">) =>
  await listTimeSuggestions.handler(
    asTestRaw<ListCtx>({
      ...baseContext(userId),
      query: { date: DAY, timezoneId: TIMEZONE },
    }),
  );

const decide = async (
  fingerprint: string,
  decision: DecisionCtx["body"]["decision"],
) =>
  await createTimeSuggestionDecision.handler(
    asTestRaw<DecisionCtx>({
      ...baseContext(ids.userA1),
      body: { fingerprint, date: DAY, timezoneId: TIMEZONE, decision },
    }),
  );

const isListResponse = (
  value: unknown,
): value is {
  date: string;
  activeMinutes: number;
  items: {
    fingerprint: string;
    durationMinutes: number;
    signalCount: number;
    evidence: unknown[];
  }[];
} =>
  typeof value === "object" &&
  value !== null &&
  "items" in value &&
  Array.isArray(value.items);

const isDecisionResponse = (
  value: unknown,
): value is {
  fingerprint: string;
  status: "accepted" | "dismissed";
  timeEntryId: string | null;
} =>
  typeof value === "object" &&
  value !== null &&
  "fingerprint" in value &&
  "timeEntryId" in value;

describe("time entry suggestions integration", () => {
  test("clusters the timekeeper's own signals and leaves other users' and billing rows out", async () => {
    const listed = await listFor(ids.userA1);
    if (!isListResponse(listed)) {
      throw new Error(`unexpected list response: ${JSON.stringify(listed)}`);
    }

    expect(listed.date).toBe(DAY);
    expect(listed.items).toHaveLength(2);
    // 09:00 -> 09:15 span (15 min) + 5 min tail; 14:00 alone gets the tail.
    expect(listed.items.map((item) => item.durationMinutes)).toEqual([20, 5]);
    expect(listed.activeMinutes).toBe(25);
    expect(listed.items[0]).toMatchObject({
      signalCount: 3,
      evidence: [
        {
          type: "chat_thread",
          id: threadId,
          title: "Lease negotiation",
          messageCount: 2,
        },
        {
          type: "resource",
          id: ids.entityA1,
          resourceType: "entity",
          name: "Untitled",
          actions: ["update"],
        },
      ],
    });

    const otherUser = await listFor(ids.userA2);
    if (!isListResponse(otherUser)) {
      throw new Error(`unexpected list response: ${JSON.stringify(otherUser)}`);
    }
    expect(otherUser.items.map((item) => item.signalCount)).toEqual([1]);
  });

  test("accepting records a suggested entry once, then the fingerprint is spent", async () => {
    const listed = await listFor(ids.userA1);
    if (!isListResponse(listed)) {
      throw new Error(`unexpected list response: ${JSON.stringify(listed)}`);
    }
    const [first] = listed.items;
    if (!first) {
      throw new Error("expected a pending suggestion");
    }

    const accepted = await decide(first.fingerprint, {
      type: "accept",
      durationMinutes: 18,
      narrative: "Lease negotiation: reviewed the draft and replied",
      billable: false,
    });
    if (!isDecisionResponse(accepted) || accepted.timeEntryId === null) {
      throw new Error(
        `unexpected accept response: ${JSON.stringify(accepted)}`,
      );
    }
    expect(accepted).toMatchObject({
      fingerprint: first.fingerprint,
      status: "accepted",
    });
    const timeEntryId = brandPersistedTimeEntryId(accepted.timeEntryId);

    const entry = await testDb.query.timeEntries.findFirst({
      where: { id: { eq: timeEntryId } },
      columns: {
        source: true,
        durationMinutes: true,
        billedMinutes: true,
        dateWorked: true,
        userId: true,
      },
    });
    expect(entry).toEqual({
      source: "suggested",
      durationMinutes: 18,
      billedMinutes: 18,
      dateWorked: DAY,
      userId: ids.userA1,
    });

    const [stored] = await testDb
      .select({
        status: timeEntrySuggestions.status,
        timeEntryId: timeEntrySuggestions.timeEntryId,
        evidence: timeEntrySuggestions.evidence,
      })
      .from(timeEntrySuggestions)
      .where(eq(timeEntrySuggestions.fingerprint, first.fingerprint));
    expect(stored?.status).toBe("accepted");
    expect(stored?.timeEntryId).toBe(timeEntryId);
    expect(stored?.evidence).toEqual(first.evidence);

    const relisted = await listFor(ids.userA1);
    if (!isListResponse(relisted)) {
      throw new Error(`unexpected list response: ${JSON.stringify(relisted)}`);
    }
    expect(relisted.items.map((item) => item.fingerprint)).not.toContain(
      first.fingerprint,
    );

    const again = await decide(first.fingerprint, {
      type: "accept",
      durationMinutes: 18,
      narrative: "duplicate",
      billable: false,
    });
    expect(again).toMatchObject({ code: 409 });

    // A dismiss after an accept reports the decision that already stands.
    const dismissAfterAccept = await decide(first.fingerprint, {
      type: "dismiss",
    });
    expect(dismissAfterAccept).toEqual({
      fingerprint: first.fingerprint,
      status: "accepted",
      timeEntryId,
    });
  });

  test("dismissing hides a suggestion and repeats idempotently", async () => {
    const listed = await listFor(ids.userA1);
    if (!isListResponse(listed)) {
      throw new Error(`unexpected list response: ${JSON.stringify(listed)}`);
    }
    const [pending] = listed.items;
    if (!pending) {
      throw new Error("expected a pending suggestion");
    }

    const dismissed = await decide(pending.fingerprint, { type: "dismiss" });
    expect(dismissed).toEqual({
      fingerprint: pending.fingerprint,
      status: "dismissed",
      timeEntryId: null,
    });
    expect(await decide(pending.fingerprint, { type: "dismiss" })).toEqual(
      dismissed,
    );

    const relisted = await listFor(ids.userA1);
    if (!isListResponse(relisted)) {
      throw new Error(`unexpected list response: ${JSON.stringify(relisted)}`);
    }
    expect(relisted.items).toHaveLength(0);
    expect(relisted.activeMinutes).toBe(0);
  });

  test("a fingerprint the day never produced cannot be dismissed", async () => {
    const invented = "f".repeat(64);
    expect(await decide(invented, { type: "dismiss" })).toMatchObject({
      code: 409,
    });
    const [row] = await testDb
      .select({ id: timeEntrySuggestions.id })
      .from(timeEntrySuggestions)
      .where(eq(timeEntrySuggestions.fingerprint, invented));
    expect(row).toBeUndefined();
  });

  test("decisions are invisible to other members of the matter", async () => {
    const asOtherUser = createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA2);
    const visible = await asOtherUser((tx) =>
      tx
        .select({ id: timeEntrySuggestions.id })
        .from(timeEntrySuggestions)
        .where(eq(timeEntrySuggestions.userId, ids.userA1)),
    );
    expect(visible.isOk() && visible.value).toEqual([]);
  });
});
