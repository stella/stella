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

import { user as authUser } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  auditLogs,
  chatMessages,
  chatThreads,
  featureEnrolments,
  rateEntries,
  rateTables,
  timeEntries,
  timeEntrySuggestions,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import type { AuditAction, AuditResourceType } from "@/api/lib/audit-log";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { brandPersistedTimeEntryId } from "@/api/lib/safe-id-boundaries";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import splitEntry from "../split";
import createTimeSuggestionDecision from "./decisions/create";
import listTimeSuggestions from "./list";

setDefaultTimeout(120_000);

type ListCtx = Parameters<typeof listTimeSuggestions.handler>[0];
type DecisionCtx = Parameters<typeof createTimeSuggestionDecision.handler>[0];
type SplitCtx = Parameters<typeof splitEntry.handler>[0];

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
const rateTableId = createSafeId<"rateTable">();
const rateEntryId = createSafeId<"rateEntry">();

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

  await testDb
    .update(authUser)
    .set({ emailVerified: true })
    .where(inArray(authUser.id, [ids.userA1, ids.userA2]));
  await testDb
    .insert(featureEnrolments)
    .values([
      {
        organizationId: ids.orgA,
        userId: ids.userA1,
        featureId: "time-billing",
      },
      {
        organizationId: ids.orgA,
        userId: ids.userA2,
        featureId: "time-billing",
      },
    ])
    .onConflictDoNothing();

  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    userId: ids.userA1,
    workspaceId: ids.wsA1,
    title: "Lease negotiation",
  });
  const content = (text: string) =>
    toPersistedChatMessageContentV3({
      data: [{ type: "text" as const, content: text }],
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
    await testDb.delete(rateTables).where(eq(rateTables.id, rateTableId));
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
  memberRole: sessionMemberRole("owner"),
  orgAIConfig: null,
  orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
  managedAIResidency: "eu" as const,
  params: { workspaceId: ids.wsA1 },
  promptCachingEnabled: false,
  recordAuditEvent: async () => {},
  request: new Request(`https://example.test/workspaces/${ids.wsA1}`),
  route: "/v1/time-entries/:workspaceId/suggestions" satisfies ApiRoutePath,
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
    engagedMinutes: number;
    signalCount: number;
    alreadyCovered: boolean;
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
    expect(listed.items.map((item) => item.durationMinutes)).toEqual([24, 6]);
    expect(listed.items.map((item) => item.engagedMinutes)).toEqual([20, 5]);
    expect(listed.activeMinutes).toBe(30);
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
    await testDb.insert(rateTables).values({
      id: rateTableId,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      name: "Suggestion test rate",
      currency: "USD",
      isDefault: true,
    });
    await testDb.insert(rateEntries).values({
      id: rateEntryId,
      workspaceId: ids.wsA1,
      rateTableId,
      userId: ids.userA1,
      hourlyRate: cents(20_000),
      effectiveFrom: DAY,
    });
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
      narrativeLanguage: "cs-CZ",
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
        narrativeLanguage: true,
        billable: true,
        userId: true,
      },
    });
    expect(entry).toEqual({
      source: "suggested",
      durationMinutes: 18,
      billedMinutes: 18,
      dateWorked: DAY,
      narrativeLanguage: "cs-CZ",
      billable: true,
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

    const extensionId = createSafeId<"chatMessage">();
    messageIds.push(extensionId);
    await testDb.insert(chatMessages).values({
      id: extensionId,
      threadId,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      role: "user",
      content: toPersistedChatMessageContentV3({
        data: [{ type: "text", content: "follow-up" }],
      }),
      // Inside the accepted window, which ran through 09:15 plus the tail.
      createdAt: at("09:16:00"),
    });

    const relisted = await listFor(ids.userA1);
    if (!isListResponse(relisted)) {
      throw new Error(`unexpected list response: ${JSON.stringify(relisted)}`);
    }
    expect(relisted.items.map((item) => item.fingerprint)).not.toContain(
      first.fingerprint,
    );
    // Only the minute beyond the accepted window is new; the four inside it
    // were billed with the accepted suggestion.
    expect(relisted.items.at(0)).toMatchObject({
      engagedMinutes: 1,
      signalCount: 1,
      evidence: [
        {
          type: "chat_thread",
          signals: [{ resourceId: extensionId }],
        },
      ],
    });

    const again = await decide(first.fingerprint, {
      type: "accept",
      durationMinutes: 18,
      narrative: "duplicate",
      billable: false,
    });
    expect(again).toEqual(accepted);

    // A dismiss after an accept reports the decision that already stands.
    const dismissAfterAccept = await decide(first.fingerprint, {
      type: "dismiss",
    });
    expect(dismissAfterAccept).toEqual({
      fingerprint: first.fingerprint,
      status: "accepted",
      timeEntryId,
    });

    const split = await splitEntry.handler(
      asTestRaw<SplitCtx>({
        ...baseContext(ids.userA1),
        body: {
          id: timeEntryId,
          splits: [
            { workItemId: ids.entityA1, percentage: 50 },
            { workItemId: ids.entityA1, percentage: 50 },
          ],
        },
      }),
    );
    if (!("splitGroupId" in split)) {
      throw new Error("split did not return a group id");
    }
    expect(typeof split.splitGroupId).toBe("string");
    const splitRows = await testDb.query.timeEntries.findMany({
      where: { splitGroupId: { eq: split.splitGroupId } },
      columns: { narrativeLanguage: true },
    });
    expect(splitRows).toEqual([
      { narrativeLanguage: "cs-CZ" },
      { narrativeLanguage: "cs-CZ" },
    ]);
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
    // Accepting what was dismissed elsewhere is refused, never reported as
    // logged time.
    expect(
      await decide(pending.fingerprint, {
        type: "accept",
        durationMinutes: 18,
        narrative: "accepted in another tab",
      }),
    ).toMatchObject({ code: 409 });
    expect(
      await testDb.$count(
        timeEntries,
        eq(timeEntries.narrative, "accepted in another tab"),
      ),
    ).toBe(0);

    const extensionId = createSafeId<"chatMessage">();
    messageIds.push(extensionId);
    await testDb.insert(chatMessages).values({
      id: extensionId,
      threadId,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      role: "user",
      content: toPersistedChatMessageContentV3({
        data: [{ type: "text", content: "after dismissal" }],
      }),
      createdAt: at("09:25:00"),
    });

    const relisted = await listFor(ids.userA1);
    if (!isListResponse(relisted)) {
      throw new Error(`unexpected list response: ${JSON.stringify(relisted)}`);
    }
    expect(relisted.items.at(0)).toMatchObject({
      engagedMinutes: 5,
      signalCount: 1,
      evidence: [
        {
          type: "chat_thread",
          signals: [{ resourceId: extensionId }],
        },
      ],
    });
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

  test("a decision without signal identities still settles its own suggestion", async () => {
    const listed = await listFor(ids.userA1);
    if (!isListResponse(listed)) {
      throw new Error(`unexpected list response: ${JSON.stringify(listed)}`);
    }
    const [withoutSignals, withoutEvidence] = listed.items.map(
      (item) => item.fingerprint,
    );
    if (withoutSignals === undefined || withoutEvidence === undefined) {
      throw new Error("expected two pending suggestions to decide");
    }
    // Decisions written before they recorded their signal identities: one
    // with evidence that names no signals, one with no evidence at all.
    await testDb.insert(timeEntrySuggestions).values([
      {
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        userId: ids.userA1,
        dateWorked: DAY,
        fingerprint: withoutSignals,
        status: "dismissed",
        evidence: asTestRaw<
          (typeof timeEntrySuggestions.$inferInsert)["evidence"]
        >([
          {
            type: "chat_thread",
            id: threadId,
            title: "Lease",
            messageCount: 1,
          },
        ]),
      },
      {
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        userId: ids.userA1,
        dateWorked: DAY,
        fingerprint: withoutEvidence,
        status: "dismissed",
        evidence: null,
      },
    ]);
    try {
      const relisted = await listFor(ids.userA1);
      if (!isListResponse(relisted)) {
        throw new Error(
          `unexpected list response: ${JSON.stringify(relisted)}`,
        );
      }
      const pending = relisted.items.map((item) => item.fingerprint);
      expect(pending).not.toContain(withoutSignals);
      expect(pending).not.toContain(withoutEvidence);
    } finally {
      await testDb
        .delete(timeEntrySuggestions)
        .where(
          inArray(timeEntrySuggestions.fingerprint, [
            withoutSignals,
            withoutEvidence,
          ]),
        );
    }
  });

  const insertRecordedTime = async (
    values: Pick<
      typeof timeEntries.$inferInsert,
      | "dateWorked"
      | "durationMinutes"
      | "source"
      | "timerStartedAt"
      | "timerStoppedAt"
    >,
  ) => {
    const id = brandPersistedTimeEntryId(createSafeId<"timeEntry">());
    await testDb.insert(timeEntries).values({
      id,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      timezoneId: TIMEZONE,
      billedMinutes: values.durationMinutes,
      rateAtEntry: cents(0),
      currency: "CZK",
      narrative: "Recorded elsewhere",
      billable: true,
      status: "draft",
      ...values,
    });
    return id;
  };

  test("a previous day's timer that runs past midnight covers this day's activity", async () => {
    const before = await listFor(ids.userA1);
    if (!isListResponse(before)) {
      throw new Error(`unexpected list response: ${JSON.stringify(before)}`);
    }
    expect(before.items.length).toBeGreaterThan(0);
    const previousDay = Temporal.PlainDate.from(DAY)
      .subtract({ days: 1 })
      .toString();
    const timerId = await insertRecordedTime({
      dateWorked: previousDay,
      durationMinutes: 24 * 60,
      source: "timer",
      timerStartedAt: new Date(`${previousDay}T23:30:00Z`),
      timerStoppedAt: at("23:30:00"),
    });
    try {
      const after = await listFor(ids.userA1);
      if (!isListResponse(after)) {
        throw new Error(`unexpected list response: ${JSON.stringify(after)}`);
      }
      expect(after.items).toEqual([]);
    } finally {
      await testDb.delete(timeEntries).where(eq(timeEntries.id, timerId));
    }
  });

  test("an accepted suggestion's minutes never mark other activity as covered", async () => {
    const acceptedId = await insertRecordedTime({
      dateWorked: DAY,
      durationMinutes: 600,
      source: "suggested",
      timerStartedAt: null,
      timerStoppedAt: null,
    });
    try {
      const listed = await listFor(ids.userA1);
      if (!isListResponse(listed)) {
        throw new Error(`unexpected list response: ${JSON.stringify(listed)}`);
      }
      expect(listed.items.length).toBeGreaterThan(0);
      expect(listed.items.map((item) => item.alreadyCovered)).not.toContain(
        true,
      );
    } finally {
      await testDb.delete(timeEntries).where(eq(timeEntries.id, acceptedId));
    }
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
