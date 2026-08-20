import { mock } from "bun:test";

let activeTestDb: any;
const rootDbProxy = new Proxy({} as any, {
  get(_, prop, receiver) {
    if (!activeTestDb) {
      throw new Error("activeTestDb is not initialized yet!");
    }
    return Reflect.get(activeTestDb, prop, receiver);
  },
});

void mock.module("@/api/db/root", () => ({
  rootDb: rootDbProxy,
}));

const mockLimits = {
  mentionTargetsMax: 10,
  deadlineWorkspacesBatchSize: 2,
};

void mock.module("@/api/lib/limits", () => ({
  LIMITS: mockLimits,
}));

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { user as authUser, organization } from "@/api/db/auth-schema";
import { entities, taskAssignees, workspaces, notifications } from "@/api/db/schema";
import { toSafeId, createSafeId } from "@/api/lib/branded-types";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import { checkDeadlines } from "./check-deadlines";
import { logger } from "@/api/lib/observability/logger";

setDefaultTimeout(120_000);

const testSuffix = Bun.randomUUIDv7();
const user1Id = toSafeId<"user">(`cd-u1-${testSuffix}`);
const user2Id = toSafeId<"user">(`cd-u2-${testSuffix}`);
const user3Id = toSafeId<"user">(`cd-u3-${testSuffix}`);
const orgId = createSafeId<"organization">();

const ws1Id = createSafeId<"workspace">();
const ws2Id = createSafeId<"workspace">();
const ws3Id = createSafeId<"workspace">();
const ws4Id = createSafeId<"workspace">();
const ws5Id = createSafeId<"workspace">();

const getTomorrowString = () => {
  const nowInPrague = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Prague" }));
  const tomorrowInPrague = new Date(nowInPrague);
  tomorrowInPrague.setDate(tomorrowInPrague.getDate() + 1);
  const year = tomorrowInPrague.getFullYear();
  const month = String(tomorrowInPrague.getMonth() + 1).padStart(2, "0");
  const day = String(tomorrowInPrague.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const getTodayString = () => {
  const nowInPrague = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Prague" }));
  const year = nowInPrague.getFullYear();
  const month = String(nowInPrague.getMonth() + 1).padStart(2, "0");
  const day = String(nowInPrague.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const getInTwoDaysString = () => {
  const nowInPrague = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Prague" }));
  const inTwoDaysInPrague = new Date(nowInPrague);
  inTwoDaysInPrague.setDate(inTwoDaysInPrague.getDate() + 2);
  const year = inTwoDaysInPrague.getFullYear();
  const month = String(inTwoDaysInPrague.getMonth() + 1).padStart(2, "0");
  const day = String(inTwoDaysInPrague.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

beforeAll(async () => {
  activeTestDb = await getTestDb();

  // 0. Seed organization
  await activeTestDb.insert(organization).values({
    id: orgId,
    name: "CD Organization",
    slug: `cd-org-${testSuffix}`,
    createdAt: new Date(),
  });

  // 1. Seed users
  await activeTestDb.insert(authUser).values([
    { id: user1Id, email: `user1-${testSuffix}@stella.dev`, name: "CD User 1" },
    { id: user2Id, email: `user2-${testSuffix}@stella.dev`, name: "CD User 2" },
    { id: user3Id, email: `user3-${testSuffix}@stella.dev`, name: "CD User 3" },
  ]);

  // 2. Seed workspaces
  await activeTestDb.insert(workspaces).values([
    { id: ws1Id, organizationId: orgId, name: "CD Workspace 1", reference: `REF-${ws1Id}` },
    { id: ws2Id, organizationId: orgId, name: "CD Workspace 2", reference: `REF-${ws2Id}` },
    { id: ws3Id, organizationId: orgId, name: "CD Workspace 3", reference: `REF-${ws3Id}` },
    { id: ws4Id, organizationId: orgId, name: "CD Workspace 4", reference: `REF-${ws4Id}` },
    { id: ws5Id, organizationId: orgId, name: "CD Workspace 5", reference: `REF-${ws5Id}` },
  ]);
});

afterAll(async () => {
  if (activeTestDb) {
    const wsIds = [ws1Id, ws2Id, ws3Id, ws4Id, ws5Id];
    const uIds = [user1Id, user2Id, user3Id];
    await activeTestDb.delete(notifications).where(inArray(notifications.userId, uIds));
    await activeTestDb.delete(taskAssignees).where(inArray(taskAssignees.userId, uIds));
    await activeTestDb.delete(entities).where(inArray(entities.workspaceId, wsIds));
    await activeTestDb.delete(workspaces).where(inArray(workspaces.id, wsIds));
    await activeTestDb.delete(authUser).where(inArray(authUser.id, uIds));
    await activeTestDb.delete(organization).where(eq(organization.id, orgId));
  }
  await releaseTestDb();
});

describe("checkDeadlines scheduler task", () => {
  test("processes tasks due tomorrow, fallbacks to creator, distributes to assignees, supports multi-page workspace pagination, and is idempotent", async () => {
    const tomorrowStr = getTomorrowString();
    const todayStr = getTodayString();
    const inTwoDaysStr = getInTwoDaysString();

    const t1Id = createSafeId<"entity">();
    const t2Id = createSafeId<"entity">();
    const t3Id = createSafeId<"entity">();
    const t4Id = createSafeId<"entity">();
    const t5Id = createSafeId<"entity">();
    const t6Id = createSafeId<"entity">();
    const t7Id = createSafeId<"entity">();
    const t8Id = createSafeId<"entity">();

    // Seed entities
    await activeTestDb.insert(entities).values([
      // WS1: Tomorrow vs Today vs InTwoDays
      { id: t1Id, workspaceId: ws1Id, kind: "task", name: "Due Tomorrow Task", dueDate: tomorrowStr, createdBy: user1Id },
      { id: t2Id, workspaceId: ws1Id, kind: "task", name: "Due Today Task", dueDate: todayStr, createdBy: user1Id },
      { id: t3Id, workspaceId: ws1Id, kind: "task", name: "Due In Two Days Task", dueDate: inTwoDaysStr, createdBy: user1Id },

      // WS2: Task with multiple assignees
      { id: t4Id, workspaceId: ws2Id, kind: "task", name: "Multi Assignee Task", dueDate: tomorrowStr, createdBy: user1Id },

      // WS2: Task with no assignees (creator fallback)
      { id: t5Id, workspaceId: ws2Id, kind: "task", name: "Creator Fallback Task", dueDate: tomorrowStr, createdBy: user3Id },

      // WS3, WS4, WS5: pagination verification (batchSize = 2)
      { id: t6Id, workspaceId: ws3Id, kind: "task", name: "WS3 Tomorrow Task", dueDate: tomorrowStr, createdBy: user1Id },
      { id: t7Id, workspaceId: ws4Id, kind: "task", name: "WS4 Tomorrow Task", dueDate: tomorrowStr, createdBy: user1Id },
      { id: t8Id, workspaceId: ws5Id, kind: "task", name: "WS5 Tomorrow Task", dueDate: tomorrowStr, createdBy: user1Id },
    ]);

    // Seed task assignees for t4 (User1 and User2)
    await activeTestDb.insert(taskAssignees).values([
      { id: createSafeId<"taskAssignee">(), workspaceId: ws2Id, entityId: t4Id, userId: user1Id, role: "assignee" },
      { id: createSafeId<"taskAssignee">(), workspaceId: ws2Id, entityId: t4Id, userId: user2Id, role: "assignee" },
    ]);

    // Run scheduler task
    await checkDeadlines({
      logger,
      job: {} as any,
      payload: null,
      runId: createSafeId<"schedulerJobRun">(),
      scheduleContinuation: () => undefined,
      signal: new AbortController().signal,
    });

    // 1. Verify WS1 (T1 due tomorrow triggers notification to User1, T2/T3 do not)
    const notifsUser1 = await activeTestDb
      .select()
      .from(notifications)
      .where(eq(notifications.userId, user1Id));

    // Verify User1 notifications
    const user1NotifKinds = notifsUser1.map((n: any) => n.kind);
    expect(user1NotifKinds).toContain("notifications.taskDeadline");

    const t1Notif = notifsUser1.find((n: any) => n.entityId === t1Id);
    expect(t1Notif).toBeDefined();
    expect(t1Notif.metadata).toEqual({
      taskName: "Due Tomorrow Task",
      dueDate: tomorrowStr,
      workspaceId: ws1Id,
    });

    const t2Notif = notifsUser1.find((n: any) => n.entityId === t2Id);
    expect(t2Notif).toBeUndefined();

    const t3Notif = notifsUser1.find((n: any) => n.entityId === t3Id);
    expect(t3Notif).toBeUndefined();

    // 2. Verify WS2: T4 (User1 + User2) and T5 (CreatorFallback to User3)
    const notifsUser2 = await activeTestDb
      .select()
      .from(notifications)
      .where(eq(notifications.userId, user2Id));
    const t4NotifUser2 = notifsUser2.find((n: any) => n.entityId === t4Id);
    expect(t4NotifUser2).toBeDefined();

    const notifsUser3 = await activeTestDb
      .select()
      .from(notifications)
      .where(eq(notifications.userId, user3Id));
    const t5NotifUser3 = notifsUser3.find((n: any) => n.entityId === t5Id);
    expect(t5NotifUser3).toBeDefined();

    // 3. Verify Pagination across WS3, WS4, WS5
    const ws3Notif = notifsUser1.find((n: any) => n.entityId === t6Id);
    expect(ws3Notif).toBeDefined();
    const ws4Notif = notifsUser1.find((n: any) => n.entityId === t7Id);
    expect(ws4Notif).toBeDefined();
    const ws5Notif = notifsUser1.find((n: any) => n.entityId === t8Id);
    expect(ws5Notif).toBeDefined();

    // 4. Verify Idempotency: run scheduler task a second time
    const initialNotificationCount = (await activeTestDb.select().from(notifications)).length;
    await checkDeadlines({
      logger,
      job: {} as any,
      payload: null,
      runId: createSafeId<"schedulerJobRun">(),
      scheduleContinuation: () => undefined,
      signal: new AbortController().signal,
    });
    const postRunNotificationCount = (await activeTestDb.select().from(notifications)).length;
    expect(postRunNotificationCount).toBe(initialNotificationCount);
  });
});
