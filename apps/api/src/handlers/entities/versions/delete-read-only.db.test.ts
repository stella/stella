import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import { roles } from "@stll/permissions";

import { organization, user } from "@/api/db/auth-schema";
import type { SafeDb } from "@/api/db/safe-db";
import { entities, entityVersions, workspaces } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isMemberRole, type MemberRole } from "@/api/lib/member-roles";
import {
  hasMemberPermission,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import deleteEntityVersionEndpoint, {
  deleteEntityVersionHandler,
} from "./delete";

// Deleting one version of a document (REST `entities.versions.delete`, MCP
// `delete_document` with `version_id`) is an entity update. A read-only
// document refuses it for every role that holds that grant, on the one
// handler both surfaces run.

const MEMBER_ROLES: readonly MemberRole[] =
  Object.keys(roles).filter(isMemberRole);

let db: TestDatabase;
const orgIds: SafeId<"organization">[] = [];
const userIds: SafeId<"user">[] = [];

beforeAll(
  async () => {
    db = await getTestDb();
  },
  { timeout: 30_000 },
);

afterAll(async () => {
  if (orgIds.length > 0) {
    await db.delete(organization).where(inArray(organization.id, orgIds));
  }
  if (userIds.length > 0) {
    await db.delete(user).where(inArray(user.id, userIds));
  }
  await releaseTestDb();
});

/** A document with two live versions; the older one is the deletion target. */
const seedDocument = async ({ readOnly }: { readOnly: boolean }) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const workspaceId = createSafeId<"workspace">();
  const entityId = createSafeId<"entity">();
  const olderVersionId = createSafeId<"entityVersion">();
  const currentVersionId = createSafeId<"entityVersion">();
  await db.insert(organization).values({
    id: organizationId,
    name: "Version deletion",
    slug: organizationId,
    createdAt: new Date(),
  });
  orgIds.push(organizationId);
  await db.insert(user).values({
    id: userId,
    name: "Version deletion user",
    email: `${userId}@example.test`,
  });
  userIds.push(userId);
  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Matter",
    reference: "M",
  });
  await db.insert(entities).values({
    id: entityId,
    workspaceId,
    kind: "document",
    name: "Agreement.docx",
    readOnly,
  });
  await db.insert(entityVersions).values([
    { id: olderVersionId, entityId, workspaceId, versionNumber: 1 },
    { id: currentVersionId, entityId, workspaceId, versionNumber: 2 },
  ]);
  await db
    .update(entities)
    .set({ currentVersionId })
    .where(eq(entities.id, entityId));
  const safeDb = asTestRaw<SafeDb>(
    createSafeDb(db, [workspaceId], organizationId, userId),
  );
  return { entityId, olderVersionId, safeDb, userId, workspaceId };
};

const deleteOlderVersion = async (
  seeded: Awaited<ReturnType<typeof seedDocument>>,
) =>
  await Result.gen(() =>
    deleteEntityVersionHandler({
      deletedByUserId: seeded.userId,
      entityId: seeded.entityId,
      recordAuditEvent: async () => undefined,
      safeDb: seeded.safeDb,
      versionId: seeded.olderVersionId,
      workspaceId: seeded.workspaceId,
    }),
  );

const isTombstoned = async (
  seeded: Awaited<ReturnType<typeof seedDocument>>,
): Promise<boolean> => {
  const rows = await db
    .select({ deletedAt: entityVersions.deletedAt })
    .from(entityVersions)
    .where(
      and(
        eq(entityVersions.id, seeded.olderVersionId),
        eq(entityVersions.entityId, seeded.entityId),
      ),
    );
  return rows.at(0)?.deletedAt !== null;
};

/** Roles the REST route admits to version deletion at all. */
const rolesAllowedToDeleteVersions = MEMBER_ROLES.filter((role) =>
  hasMemberPermission(
    sessionMemberRole(role),
    deleteEntityVersionEndpoint.config.permissions,
  ),
);

describe("version deletion on a read-only document", () => {
  test("REST grants version deletion as an entity update", () => {
    expect(deleteEntityVersionEndpoint.config.permissions).toEqual({
      entity: ["update"],
    });
    expect(rolesAllowedToDeleteVersions.length).toBeGreaterThan(0);
  });

  test.each(rolesAllowedToDeleteVersions)(
    "a %s holding the grant is refused and the version survives",
    async () => {
      const seeded = await seedDocument({ readOnly: true });
      const result = await deleteOlderVersion(seeded);
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error).toBeInstanceOf(HandlerError);
        expect(result.error).toMatchObject({
          message: "Entity is read-only",
          status: 409,
        });
      }
      expect(await isTombstoned(seeded)).toBe(false);
    },
  );

  test("the same deletion succeeds on a document that is not read-only", async () => {
    const seeded = await seedDocument({ readOnly: false });
    const result = await deleteOlderVersion(seeded);
    expect(Result.isOk(result)).toBe(true);
    expect(await isTombstoned(seeded)).toBe(true);
  });
});
