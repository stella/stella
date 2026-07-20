import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { asc, eq } from "drizzle-orm";

import { documentTypes, playbookDefinitions } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import createDocumentType from "@/api/handlers/document-types/create";
import deleteDocumentType from "@/api/handlers/document-types/delete";
import reorderDocumentTypes from "@/api/handlers/document-types/reorder";
import updateDocumentType from "@/api/handlers/document-types/update";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

// The document-types write handlers are root-scoped: they read the acting org
// from `session.activeOrganizationId` and go through `safeDb` (RLS role
// `stella`). This suite drives them against the real pglite harness with two
// distinct orgs so ownership and cross-tenant isolation are exercised for real.

let testDb: TestDatabase;
let ids: TestIds;

const noopAuditRecorder: AuditRecorder = async () => undefined;

type OrgContext = ReturnType<typeof createOrgContext>;

const createOrgContext = (
  organizationId: SafeId<"organization">,
  userId: SafeId<"user">,
) => {
  const safeDb = createSafeDb(testDb, [], organizationId, userId);

  return {
    createAuditRecorder: () => noopAuditRecorder,
    // The wrapped safe handler authorizes `organizationSettings: ["update"]`
    // against this role before invoking the generator; owner clears every gate.
    memberRole: { role: "owner" as const },
    recordAuditEvent: noopAuditRecorder,
    request: new Request("https://example.test/document-types"),
    route: "/document-types",
    safeDb,
    session: { activeOrganizationId: organizationId },
    user: { id: userId },
  };
};

// The exported `.handler` returns the *unwrapped* success payload on ok, or an
// Elysia status response (`{ code, response }`) on error — not a raw Result. So
// we mirror the cross-tenant harness: read the numeric status for errors and
// inspect the returned object fields for successes.
type TestEndpoint<TContext> = {
  handler: (context: TContext) => Promise<unknown>;
};

const runHandler = async <TContext>(
  endpoint: TestEndpoint<TContext>,
  context: OrgContext,
  requestShape: Record<string, unknown>,
): Promise<unknown> => {
  try {
    return await endpoint.handler(
      asTestRaw<TContext>({ ...context, ...requestShape }),
    );
  } catch (error) {
    return error;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// Errors surface as an Elysia status response; success payloads have no
// status-like field. `null` means "the handler returned a success payload".
const getStatusCode = (result: unknown): number | null => {
  if (!isRecord(result)) {
    return null;
  }
  for (const field of ["status", "statusCode", "code"] as const) {
    if (typeof result[field] === "number") {
      return result[field];
    }
  }
  return null;
};

type DocumentTypeRow = {
  id: SafeId<"documentType">;
  key: string;
  label: string;
  sortOrder: number;
};

const asDocumentTypeRow = (result: unknown): DocumentTypeRow => {
  expect(getStatusCode(result)).toBeNull();
  if (
    !isRecord(result) ||
    typeof result["id"] !== "string" ||
    typeof result["key"] !== "string" ||
    typeof result["label"] !== "string" ||
    typeof result["sortOrder"] !== "number"
  ) {
    throw new Error("Expected a document-type row payload");
  }
  return {
    id: toSafeId<"documentType">(result["id"]),
    key: result["key"],
    label: result["label"],
    sortOrder: result["sortOrder"],
  };
};

const createType = async (context: OrgContext, label: string) =>
  asDocumentTypeRow(
    await runHandler(createDocumentType, context, { body: { label } }),
  );

const readOrgRows = async (
  organizationId: SafeId<"organization">,
): Promise<DocumentTypeRow[]> =>
  await testDb
    .select({
      id: documentTypes.id,
      key: documentTypes.key,
      label: documentTypes.label,
      sortOrder: documentTypes.sortOrder,
    })
    .from(documentTypes)
    .where(eq(documentTypes.organizationId, organizationId))
    .orderBy(asc(documentTypes.sortOrder));

const readRow = async (
  documentTypeId: SafeId<"documentType">,
): Promise<DocumentTypeRow | undefined> =>
  (
    await testDb
      .select({
        id: documentTypes.id,
        key: documentTypes.key,
        label: documentTypes.label,
        sortOrder: documentTypes.sortOrder,
      })
      .from(documentTypes)
      .where(eq(documentTypes.id, documentTypeId))
  ).at(0);

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
});

afterAll(async () => {
  await releaseTestDb();
});

describe("document-types write handlers", () => {
  test("create: same label twice yields distinct keys and increasing sortOrder", async () => {
    const context = createOrgContext(ids.orgA, ids.userA1);

    const first = await createType(context, "NDA");
    const second = await createType(context, "NDA");

    expect(first.key).toBe("nda");
    expect(second.key).toBe("nda-2");
    // Newest sorts last.
    expect(second.sortOrder).toBeGreaterThan(first.sortOrder);
    // The row is returned to the caller.
    expect(first.label).toBe("NDA");
  });

  test("update: renaming changes the label but leaves the key unchanged", async () => {
    const context = createOrgContext(ids.orgA, ids.userA1);
    const created = await createType(context, "Lease Agreement");

    const result = await runHandler(updateDocumentType, context, {
      params: { documentTypeId: created.id },
      body: { label: "Rental Lease" },
    });
    const updated = asDocumentTypeRow(result);

    expect(updated.id).toBe(created.id);
    expect(updated.label).toBe("Rental Lease");
    expect(updated.key).toBe(created.key);
  });

  test("delete: succeeds for an unused document type", async () => {
    const context = createOrgContext(ids.orgA, ids.userA1);
    const created = await createType(context, "Supply Agreement");

    const result = await runHandler(deleteDocumentType, context, {
      params: { documentTypeId: created.id },
    });

    expect(getStatusCode(result)).toBeNull();
    expect(await readRow(created.id)).toBeUndefined();
  });

  test("delete: is blocked with 409 while a playbook references its key", async () => {
    const context = createOrgContext(ids.orgA, ids.userA1);
    const created = await createType(context, "Distribution Agreement");

    // A playbook stores the type's `key` in its JSONB scope (not a FK), so we
    // seed one directly to reproduce the "in use" guard.
    await testDb.insert(playbookDefinitions).values({
      id: toSafeId<"playbookDefinition">(Bun.randomUUIDv7()),
      organizationId: ids.orgA,
      name: "Distribution review",
      scope: { documentTypeKey: created.key },
      positions: { version: 2, items: [] },
    });

    const result = await runHandler(deleteDocumentType, context, {
      params: { documentTypeId: created.id },
    });

    expect(getStatusCode(result)).toBe(409);
    // The row is left in place so the user can reassign the playbook first.
    expect(await readRow(created.id)).toBeDefined();
  });

  test("reorder: sortOrder follows array position; foreign ids are ignored", async () => {
    const context = createOrgContext(ids.orgA, ids.userA1);
    const a = await createType(context, "Reorder Alpha");
    const b = await createType(context, "Reorder Bravo");
    const c = await createType(context, "Reorder Charlie");

    // A document type owned by org B: not owned by org A, so it must be ignored
    // rather than error.
    const foreign = await createType(
      createOrgContext(ids.orgB, ids.userB1),
      "Reorder Foreign",
    );

    const result = await runHandler(reorderDocumentTypes, context, {
      body: { orderedIds: [c.id, a.id, b.id, foreign.id] },
    });

    expect(getStatusCode(result)).toBeNull();
    expect((await readRow(c.id))?.sortOrder).toBe(0);
    expect((await readRow(a.id))?.sortOrder).toBe(1);
    expect((await readRow(b.id))?.sortOrder).toBe(2);
    // The foreign row was untouched (still owned by org B).
    const foreignAfter = await readRow(foreign.id);
    expect(foreignAfter).toBeDefined();
    expect(await readOrgRows(ids.orgB)).toContainEqual(
      expect.objectContaining({ id: foreign.id }),
    );
  });

  test("isolation: org B cannot update an org A document type", async () => {
    const orgA = createOrgContext(ids.orgA, ids.userA1);
    const orgB = createOrgContext(ids.orgB, ids.userB1);
    const created = await createType(orgA, "Isolation Update Target");

    const result = await runHandler(updateDocumentType, orgB, {
      params: { documentTypeId: created.id },
      body: { label: "Hijacked" },
    });

    expect(getStatusCode(result)).toBe(404);
    // Org A's row is unchanged.
    const after = await readRow(created.id);
    expect(after?.label).toBe("Isolation Update Target");
  });

  test("isolation: org B cannot delete an org A document type", async () => {
    const orgA = createOrgContext(ids.orgA, ids.userA1);
    const orgB = createOrgContext(ids.orgB, ids.userB1);
    const created = await createType(orgA, "Isolation Delete Target");

    const result = await runHandler(deleteDocumentType, orgB, {
      params: { documentTypeId: created.id },
    });

    expect(getStatusCode(result)).toBe(404);
    // Org A's row still exists.
    expect(await readRow(created.id)).toBeDefined();
  });
});
