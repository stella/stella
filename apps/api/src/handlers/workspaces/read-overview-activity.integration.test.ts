import { panic } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { auditLogs, entities } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
  type FieldDiffs,
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { withTenantActionSizePolicy } from "@/api/lib/rate-limit/action-size-limits";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import exportOverviewActivity from "./export-overview-activity";
import { toMatterActivityFilters } from "./matter-activity-query";
import readOverviewActivity from "./read-overview-activity";
import readOverviewActivityActors from "./read-overview-activity-actors";
import {
  readOverviewActivityExport,
  readOverviewActivityPage,
} from "./read-overview-activity.query";

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
  action?:
    | typeof AUDIT_ACTION.CREATE
    | typeof AUDIT_ACTION.UPDATE
    | typeof AUDIT_ACTION.DELETE;
  changes?: FieldDiffs;
  organizationId: SafeId<"organization">;
  resourceId?: string;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
};

/** Write one document-category entry through the canonical recorder. */
const seedActivity = async ({
  action = AUDIT_ACTION.UPDATE,
  changes,
  organizationId,
  resourceId = Bun.randomUUIDv7(),
  workspaceId,
  userId,
}: SeedActivityOptions): Promise<SafeId<"auditLog">> => {
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
    ...(changes && { changes }),
  });

  const written = await testDb
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(
      and(eq(auditLogs.resourceId, resourceId), eq(auditLogs.action, action)),
    );
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
  target: {
    deleted: boolean;
    kind: string;
    mimeType: string | null;
    name: string | null;
  };
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
      memberRole: sessionMemberRole("owner"),
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
  test("export completeness is independent of the tenant page size", async () => {
    const options = {
      filters: toMatterActivityFilters({}),
      organizationId: ids.orgA,
      safeDb: createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
      workspaceId: ids.wsA1,
    };
    const complete = (
      await readOverviewActivityExport({ ...options, cap: 100 })
    ).unwrap();
    expect(complete.length).toBeGreaterThan(1);

    await withTenantActionSizePolicy(
      { pageSize: 1, requestBytes: 100_000, responseBytes: 100_000 },
      async () => {
        const page = (
          await readOverviewActivityPage({
            ...options,
            cursor: null,
            limit: 100,
          })
        ).unwrap();
        expect(page.items).toHaveLength(1);
        expect(page.nextCursor).not.toBeNull();

        const exact = (
          await readOverviewActivityExport({ ...options, cap: complete.length })
        ).unwrap();
        expect(exact).toEqual(complete);

        const cap = complete.length - 1;
        const overflow = await readOverviewActivityExport({ ...options, cap });
        expect(overflow.isErr()).toBe(true);
        if (overflow.isErr()) {
          expect(overflow.error).toMatchObject({
            status: 413,
            message: `The export exceeds ${cap} rows. Narrow the filters and try again.`,
          });
        }
      },
    );
  });
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
      memberRole: sessionMemberRole("owner"),
      recordAuditEvent: auditRecorderDouble(),
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

  test("a folder create surfaces the folder kind, not a document", async () => {
    const folderId = toSafeId<"entity">(Bun.randomUUIDv7());
    await testDb.insert(entities).values({
      id: folderId,
      workspaceId: ids.wsA1,
      kind: "folder",
      name: "Pleadings",
    });

    try {
      const folderCreateId = await seedActivity({
        action: AUDIT_ACTION.CREATE,
        organizationId: ids.orgA,
        resourceId: folderId,
        workspaceId: ids.wsA1,
        userId: ids.userA1,
      });
      const items = await readActivityOfWorkspaceA1();

      expect(
        items.find((activityItem) => activityItem.id === folderCreateId)
          ?.target,
      ).toMatchObject({ kind: "folder", name: "Pleadings" });
    } finally {
      await testDb.delete(entities).where(eq(entities.id, folderId));
    }
  });

  test("a deleted folder keeps its kind via the audit snapshot", async () => {
    const folderId = Bun.randomUUIDv7();
    const folderDeleteId = await seedActivity({
      action: AUDIT_ACTION.DELETE,
      changes: {
        deleted: { old: { kind: "folder", name: "Pleadings" }, new: null },
      },
      organizationId: ids.orgA,
      resourceId: folderId,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
    });

    const items = await readActivityOfWorkspaceA1();

    expect(
      items.find((activityItem) => activityItem.id === folderDeleteId)?.target,
    ).toMatchObject({ deleted: true, kind: "folder", name: "Pleadings" });
  });

  test("a deleted document keeps its MIME type via the audit snapshot", async () => {
    const documentId = Bun.randomUUIDv7();
    const documentDeleteId = await seedActivity({
      action: AUDIT_ACTION.DELETE,
      changes: {
        deleted: {
          old: {
            kind: "document",
            mimeType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            fileName: "Agreement.docx",
            name: "Agreement",
          },
          new: null,
        },
      },
      organizationId: ids.orgA,
      resourceId: documentId,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
    });

    const items = await readActivityOfWorkspaceA1();

    expect(
      items.find((activityItem) => activityItem.id === documentDeleteId)
        ?.target,
    ).toMatchObject({
      deleted: true,
      kind: "document",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      name: "Agreement.docx",
    });
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
          memberRole: sessionMemberRole("owner"),
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
