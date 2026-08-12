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

import readOverviewActivity from "./read-overview-activity";

// Evidence for the `no-unscoped-user-query` waiver on the `user` import: the
// actor lookup is bounded by the ids the activity rows carry, and those rows
// are pinned to one authorized organization and matter. `audit_logs` RLS
// (`audit_logs_select`) enforces the organization only, so the matter boundary
// — and with it every identity the payload can name — rests on this query's own
// workspace predicate.

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;

const seededAuditLogIds: SafeId<"auditLog">[] = [];

let activityInOwnMatter: SafeId<"auditLog">;
let activityInSiblingMatter: SafeId<"auditLog">;
let activityInOtherOrganization: SafeId<"auditLog">;

type SeedActivityOptions = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
};

/** Write one document-category entry through the canonical recorder. */
const seedActivity = async ({
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
    panic("activity fixture wrote no row");
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

const readActivityOfWorkspaceA1 = async (): Promise<ActivityItem[]> => {
  const result = await readOverviewActivity.handler(
    asTestRaw<Parameters<typeof readOverviewActivity.handler>[0]>({
      memberRole: { role: "owner" },
      query: {},
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
});
