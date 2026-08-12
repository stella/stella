import { panic, Result } from "better-result";
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
import type { SafeDb } from "@/api/db/safe-db";
import { auditLogs } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import type { ReadAuditLogsQuery } from "./query";
import { queryAuditLogPage } from "./query";

// Evidence for the `no-body-ownership-ids` waiver on `toAuditLogConditions`:
// the caller-supplied `workspaceId` is a narrowing filter inside the session's
// organization, never a source of access. `audit_logs` carries organization-only
// RLS (`audit_logs_select` uses the organization check), so the workspace
// narrowing is enforced by this query alone: nothing below the handler will
// re-filter it.

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;

const seededAuditLogIds: SafeId<"auditLog">[] = [];

let rowInWorkspaceA1: SafeId<"auditLog">;
let rowInWorkspaceA2: SafeId<"auditLog">;
let rowOrganizationLevel: SafeId<"auditLog">;
let rowInOrganizationB: SafeId<"auditLog">;
let rowWithForeignActor: SafeId<"auditLog">;

const noopAuditRecorder: AuditRecorder = async () => undefined;

type SeedAuditEntryOptions = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace"> | null;
  userId: SafeId<"user">;
};

/** Write one entry through the canonical recorder and return its id. */
const seedAuditEntry = async ({
  organizationId,
  workspaceId,
  userId,
}: SeedAuditEntryOptions): Promise<SafeId<"auditLog">> => {
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
    panic("audit fixture wrote no row");
  }
  seededAuditLogIds.push(id);
  return id;
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  // A compliance reader of organization A who is a member of both matters:
  // the workspace pin cannot be what hides workspace A2's entries.
  safeDb = asTestRaw<SafeDb>(
    createSafeDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1),
  );

  rowInWorkspaceA1 = await seedAuditEntry({
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    userId: ids.userA1,
  });
  rowInWorkspaceA2 = await seedAuditEntry({
    organizationId: ids.orgA,
    workspaceId: ids.wsA2,
    userId: ids.userA1,
  });
  rowOrganizationLevel = await seedAuditEntry({
    organizationId: ids.orgA,
    workspaceId: null,
    userId: ids.userA1,
  });
  rowInOrganizationB = await seedAuditEntry({
    organizationId: ids.orgB,
    workspaceId: ids.wsB1,
    userId: ids.userB1,
  });
  // An entry of organization A whose actor cannot be resolved inside it (left
  // the organization, or a corrupted writer). The actor label must degrade to
  // the raw id rather than reach outside the organization for a name.
  rowWithForeignActor = await seedAuditEntry({
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    userId: ids.userB1,
  });
});

afterAll(async () => {
  await testDb
    .delete(auditLogs)
    .where(inArray(auditLogs.id, seededAuditLogIds));
  await releaseRlsFixture();
});

const readPage = async (query: ReadAuditLogsQuery) => {
  const result = await Result.gen(() =>
    queryAuditLogPage({
      safeDb,
      organizationId: ids.orgA,
      recordAuditEvent: noopAuditRecorder,
      query: { limit: 50, ...query },
    }),
  );
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
};

/** Only the entries this suite seeded; the fixture database is shared. */
const seededIdsOf = (items: readonly { id: SafeId<"auditLog"> }[]) =>
  items
    .map((item) => item.id)
    .filter((id) => seededAuditLogIds.some((seeded) => seeded === id));

describe("audit log compliance filter", () => {
  test("a workspaceId filter narrows the page instead of widening it", async () => {
    const page = await readPage({ workspaceId: ids.wsA2 });

    expect(seededIdsOf(page.items)).toEqual([rowInWorkspaceA2]);
  });

  test("an unfiltered page spans the organization, workspace entries and organization-level entries alike", async () => {
    const page = await readPage({});

    expect(seededIdsOf(page.items).toSorted()).toEqual(
      [
        rowInWorkspaceA1,
        rowInWorkspaceA2,
        rowOrganizationLevel,
        rowWithForeignActor,
      ].toSorted(),
    );
    expect(seededIdsOf(page.items)).not.toContain(rowInOrganizationB);
  });

  test("another organization's workspace id grants nothing", async () => {
    const page = await readPage({ workspaceId: ids.wsB1 });

    expect(seededIdsOf(page.items)).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  test("an actor outside the organization degrades to the raw id, never to a name or email", async () => {
    const page = await readPage({ workspaceId: ids.wsA1 });

    const foreignActorItem = page.items.find(
      (item) => item.id === rowWithForeignActor,
    );
    expect(foreignActorItem?.actor).toBe(ids.userB1);
    for (const item of page.items) {
      expect(item.actor).not.toContain("User B1");
      expect(item.actor).not.toContain(`${ids.userB1}@test.local`);
    }
  });
});
