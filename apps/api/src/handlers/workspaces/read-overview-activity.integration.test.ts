import { panic } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { auditLogs } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import exportOverviewActivity from "./export-overview-activity";
import readOverviewActivity from "./read-overview-activity";
import readOverviewActivityActors from "./read-overview-activity-actors";

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;

const seededAuditLogIds: SafeId<"auditLog">[] = [];

let activityInOwnMatter: SafeId<"auditLog">;
let agentActivityInOwnMatter: SafeId<"auditLog">;
let createdActivityInOwnMatter: SafeId<"auditLog">;
let activityInSiblingMatter: SafeId<"auditLog">;
let activityInOtherOrganization: SafeId<"auditLog">;

type SeedActivityOptions = {
  action?: typeof AUDIT_ACTION.CREATE | typeof AUDIT_ACTION.UPDATE;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
};

/** Write one document-category entry through the canonical recorder. */
const seedActivity = async ({
  action = AUDIT_ACTION.UPDATE,
  organizationId,
  workspaceId,
  userId,
}: SeedActivityOptions): Promise<SafeId<"auditLog">> => {
  const resourceId = Bun.randomUUIDv7();
  const recorder = createBackgroundAuditRecorder({
    organizationId,
    workspaceId,
    userId,
    execution: {
      performer: { type: "user", id: userId },
      trigger: { type: "direct" },
    },
  });
  await recorder(asTestRaw<Transaction>(testDb), {
    action,
    resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
    resourceId,
  });

  const written = await testDb
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(eq(auditLogs.resourceId, resourceId));
  const id = written.at(0)?.id;
  if (id === undefined) {
    panic("activity fixture wrote no row");
  }
  seededAuditLogIds.push(id);
  return id;
};

const seedFormulaAgentActivity = async (): Promise<SafeId<"auditLog">> => {
  const resourceId = Bun.randomUUIDv7();
  const recorder = createBackgroundAuditRecorder({
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    userId: ids.userA1,
    execution: {
      performer: { type: "agent", id: "formula-agent", name: "=2+2" },
      trigger: {
        type: "user_dispatch",
        source: "action",
        userId: ids.userA1,
      },
    },
  });
  await recorder(asTestRaw<Transaction>(testDb), {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
    resourceId,
  });

  const written = await testDb
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(eq(auditLogs.resourceId, resourceId));
  const id = written.at(0)?.id;
  if (id === undefined) {
    panic("agent activity fixture wrote no row");
  }
  seededAuditLogIds.push(id);
  return id;
};

type ActivityPerformer = {
  id?: string;
  name: string | null;
  type: string;
};

type ActivityItem = {
  id: SafeId<"auditLog">;
  performer: ActivityPerformer;
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;

  activityInOwnMatter = await seedActivity({
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    userId: ids.userA1,
  });
  createdActivityInOwnMatter = await seedActivity({
    action: AUDIT_ACTION.CREATE,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    userId: ids.userA1,
  });
  agentActivityInOwnMatter = await seedFormulaAgentActivity();
  // Same organization, a matter the reader is not looking at, edited by a
  // colleague who works only there.
  activityInSiblingMatter = await seedActivity({
    organizationId: ids.orgA,
    workspaceId: ids.wsA2,
    userId: ids.userA2,
  });
  activityInOtherOrganization = await seedActivity({
    organizationId: ids.orgB,
    workspaceId: ids.wsB1,
    userId: ids.userB1,
  });
});

afterAll(async () => {
  await testDb
    .delete(auditLogs)
    .where(inArray(auditLogs.id, seededAuditLogIds));
  await releaseRlsFixture();
});

type ActivityQuery = Parameters<
  typeof readOverviewActivity.handler
>[0]["query"];

const readActivityOfWorkspaceA1 = async (
  query: ActivityQuery = {},
): Promise<ActivityItem[]> => {
  const result = await readOverviewActivity.handler(
    asTestRaw<Parameters<typeof readOverviewActivity.handler>[0]>({
      memberRole: { role: "owner" },
      query,
      safeDb: createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      workspaceId: ids.wsA1,
    }),
  );
  return asTestRaw<{ items: ActivityItem[] }>(result).items;
};

describe("matter overview activity", () => {
  test("reports the matter's own activity", async () => {
    const items = await readActivityOfWorkspaceA1();

    expect(items.map((item) => item.id)).toContain(activityInOwnMatter);
    expect(
      items.find((item) => item.id === activityInOwnMatter)?.performer,
    ).toMatchObject({ id: ids.userA1, name: "User A1" });
  });

  test("composes action, actor, category, and date filters on the server", async () => {
    const items = await readActivityOfWorkspaceA1({
      action: "update",
      actorId: ids.userA1,
      category: "documents",
      from: "2020-01-01T00:00:00.000Z",
      toExclusive: "2099-01-01T00:00:00.000Z",
    });

    expect(items.map((item) => item.id)).toContain(activityInOwnMatter);
    expect(items.map((item) => item.id)).not.toContain(
      createdActivityInOwnMatter,
    );
    for (const { performer } of items) {
      expect(performer.id).toBe(ids.userA1);
    }
  });

  test("applies date bounds before pagination", async () => {
    const items = await readActivityOfWorkspaceA1({
      from: "2099-01-01T00:00:00.000Z",
    });

    expect(items).toEqual([]);
  });

  test("a sibling matter's entry and its actor never appear", async () => {
    const items = await readActivityOfWorkspaceA1();

    for (const { performer } of items) {
      expect(performer.id).not.toBe(ids.userA2);
      expect(performer.name).not.toBe("User A2");
    }
    expect(items.map((item) => item.id)).not.toContain(activityInSiblingMatter);
  });

  test("another organization's entry and its actor never appear", async () => {
    const items = await readActivityOfWorkspaceA1();

    expect(items.map((item) => item.id)).not.toContain(
      activityInOtherOrganization,
    );
    for (const { performer } of items) {
      expect(performer.id).not.toBe(ids.userB1);
      expect(performer.name).not.toBe("User B1");
    }
  });

  test("exports one bounded workspace-scoped download", async () => {
    const context = {
      memberRole: { role: "owner" },
      recordAuditEvent: async () => undefined,
      safeDb: createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      workspaceId: ids.wsA1,
    };
    const jsonResult = await exportOverviewActivity.handler(
      asTestRaw<Parameters<typeof exportOverviewActivity.handler>[0]>({
        ...context,
        query: { format: "json" },
      }),
    );
    const jsonResponse = asTestRaw<Response>(jsonResult);
    const json = asTestRaw<{
      filters: { category: string };
      items: ActivityItem[];
      version: number;
    }>(await jsonResponse.json());

    expect(jsonResponse.headers.get("Content-Disposition")).toContain(
      'attachment; filename="matter-activity.json"',
    );
    expect(json.version).toBe(1);
    expect(json.filters.category).toBe("all");
    expect(json.items.map(({ id }) => id)).toContain(agentActivityInOwnMatter);
    expect(json.items.map(({ id }) => id)).not.toContain(
      activityInSiblingMatter,
    );
    expect(json.items.map(({ id }) => id)).not.toContain(
      activityInOtherOrganization,
    );

    const csvResult = await exportOverviewActivity.handler(
      asTestRaw<Parameters<typeof exportOverviewActivity.handler>[0]>({
        ...context,
        query: { format: "csv" },
      }),
    );
    const csvResponse = asTestRaw<Response>(csvResult);
    expect(csvResponse.headers.get("Content-Type")).toBe(
      "text/csv; charset=utf-8",
    );
    expect(await csvResponse.text()).toContain('"\t=2+2"');
  });

  test("pages historical performers from authorized activity, not current matter membership", async () => {
    const historicalActivityId = await seedActivity({
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA2,
    });

    try {
      const result = await readOverviewActivityActors.handler(
        asTestRaw<Parameters<typeof readOverviewActivityActors.handler>[0]>({
          memberRole: { role: "owner" },
          query: {},
          safeDb: createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
          session: { activeOrganizationId: ids.orgA },
          user: { id: ids.userA1 },
          workspaceId: ids.wsA1,
        }),
      );
      const page = asTestRaw<{
        items: { id: string; name: string | null }[];
        nextCursor: string | null;
      }>(result);

      expect(page.items.find(({ id }) => id === ids.userA2)).toMatchObject({
        id: ids.userA2,
        name: "User A2",
      });
      expect(page.items.map(({ id }) => id)).not.toContain(ids.userB1);
    } finally {
      await testDb
        .delete(auditLogs)
        .where(eq(auditLogs.id, historicalActivityId));
    }
  });
});
