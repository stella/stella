import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { roles } from "@stll/permissions";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { entities, entityVersions } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import type { AccessibleWorkspace } from "@/api/lib/auth";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  authorizeDocumentWrite,
  authorizeDocumentWriteAccess,
  DocumentWriteRefusedError,
} from "@/api/lib/entities/authorize-document-write";
import type {
  DocumentWriteOperation,
  DocumentWriteRefusalCode,
} from "@/api/lib/entities/authorize-document-write";
import { isMemberRole } from "@/api/lib/member-roles";
import {
  authorizedMemberRole,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";
import { memberDocumentWriteAccess } from "@/api/tests/helpers/document-write-access";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const WORKSPACE_STATUSES = [
  "active",
  "archived",
  "deleting",
] as const satisfies readonly AccessibleWorkspace["status"][];

const OPERATION_PERMISSION = {
  create: "create",
  new_version: "update",
} as const satisfies Record<DocumentWriteOperation["type"], string>;

const MEMBER_ROLES = Object.keys(roles).filter(isMemberRole);

const workspaceId = toSafeId<"workspace">(Bun.randomUUIDv7());
const otherWorkspaceId = toSafeId<"workspace">(Bun.randomUUIDv7());
const entityId = toSafeId<"entity">(Bun.randomUUIDv7());

const OPERATIONS = [
  { type: "create", workspaceId },
  { type: "new_version", workspaceId, entityId },
] as const satisfies readonly DocumentWriteOperation[];

describe("document write access", () => {
  test("admits exactly the roles that hold the operation's entity permission on an active matter", () => {
    for (const role of MEMBER_ROLES) {
      for (const operation of OPERATIONS) {
        for (const status of WORKSPACE_STATUSES) {
          const granted = roles[role].authorize({
            entity: [OPERATION_PERMISSION[operation.type]],
          }).success;
          const access = authorizeDocumentWriteAccess({
            authority: sessionMemberRole(role),
            workspace: { id: workspaceId, status },
            operation,
          });
          let expected: DocumentWriteRefusalCode | "ok" = "ok";
          if (!granted) {
            expected = "forbidden";
          } else if (status !== "active") {
            expected = "workspace-not-active";
          }
          expect({
            role,
            operation: operation.type,
            status,
            outcome: Result.isError(access) ? access.error.code : "ok",
          }).toEqual({
            role,
            operation: operation.type,
            status,
            outcome: expected,
          });
        }
      }
    }
  });

  test("refuses a credential whose own permission set lacks the operation", () => {
    const access = authorizeDocumentWriteAccess({
      authority: authorizedMemberRole({
        role: "owner",
        credential: { type: "attenuated", permissions: { entity: ["create"] } },
      }),
      workspace: { id: workspaceId, status: "active" },
      operation: { type: "new_version", workspaceId, entityId },
    });

    expect(Result.isError(access) ? access.error.code : null).toBe("forbidden");
  });

  test("refuses a matter the member cannot reach, or one other than the target", () => {
    for (const workspace of [
      null,
      { id: otherWorkspaceId, status: "active" as const },
    ]) {
      const access = authorizeDocumentWriteAccess({
        authority: sessionMemberRole("owner"),
        workspace,
        operation: { type: "create", workspaceId },
      });
      expect(Result.isError(access) ? access.error.code : null).toBe(
        "workspace-not-found",
      );
    }
  });
});

describe("document write target", () => {
  let testDb: TestDatabase;
  let ids: TestIds;
  let safeDb: SafeDb;
  let readOnlyEntityId: SafeId<"entity">;

  beforeAll(async () => {
    const fixture = await getRlsFixture();
    testDb = fixture.testDb;
    ids = fixture.ids;
    safeDb = toSafeDbMock(
      asTestRaw<ScopedDb>(
        createScopedDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1),
      ),
    );

    readOnlyEntityId = toSafeId<"entity">(Bun.randomUUIDv7());
    const versionId = toSafeId<"entityVersion">(Bun.randomUUIDv7());
    await testDb.insert(entities).values({
      id: readOnlyEntityId,
      kind: "document",
      name: "read-only agreement",
      readOnly: true,
      workspaceId: ids.wsA1,
    });
    await testDb.insert(entityVersions).values({
      entityId: readOnlyEntityId,
      id: versionId,
      workspaceId: ids.wsA1,
    });
    await testDb
      .update(entities)
      .set({ currentVersionId: versionId })
      .where(eq(entities.id, readOnlyEntityId));
  });

  afterAll(async () => {
    await releaseRlsFixture();
  });

  const authorizeVersion = async (
    target: Omit<
      Extract<DocumentWriteOperation, { type: "new_version" }>,
      "type"
    >,
  ) => {
    const authorized = await authorizeDocumentWrite({
      access: memberDocumentWriteAccess({ type: "new_version", ...target }),
      safeDb,
    });
    if (Result.isOk(authorized)) {
      return { outcome: "ok", operation: authorized.value.operation };
    }
    if (!DocumentWriteRefusedError.is(authorized.error)) {
      throw authorized.error;
    }
    return { outcome: authorized.error.code };
  };

  test("admits a writable document in the target matter", async () => {
    expect(
      await authorizeVersion({ workspaceId: ids.wsA1, entityId: ids.entityA1 }),
    ).toEqual({
      outcome: "ok",
      operation: {
        type: "new_version",
        workspaceId: ids.wsA1,
        entityId: ids.entityA1,
      },
    });
  });

  test("refuses a read-only document", async () => {
    expect(
      await authorizeVersion({
        workspaceId: ids.wsA1,
        entityId: readOnlyEntityId,
      }),
    ).toEqual({ outcome: "entity-read-only" });
  });

  test("refuses a document addressed through another matter or organization", async () => {
    // entityA1 exists in wsA1; addressing it through wsA2 must not find it.
    expect(
      await authorizeVersion({ workspaceId: ids.wsA2, entityId: ids.entityA1 }),
    ).toEqual({ outcome: "entity-not-found" });
    expect(
      await authorizeVersion({ workspaceId: ids.wsA1, entityId: ids.entityB1 }),
    ).toEqual({ outcome: "entity-not-found" });
  });

  test("passes a create through with its access unchanged", async () => {
    const authorized = await authorizeDocumentWrite({
      access: memberDocumentWriteAccess({
        type: "create",
        workspaceId: ids.wsA1,
      }),
      safeDb,
    });

    expect(Result.isOk(authorized) ? authorized.value.operation : null).toEqual(
      {
        type: "create",
        workspaceId: ids.wsA1,
      },
    );
  });
});
