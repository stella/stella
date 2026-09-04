import { Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { pdfAnonymizationRuns } from "@/api/db/schema";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";
import { PDF_MIME_TYPE } from "@/api/mime-types";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type {
  createScopedQuery,
  TestDatabase,
} from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;
let scopedQuery: ReturnType<typeof createScopedQuery>;
const generatedRunIds = new Set<SafeId<"pdfAnonymizationRun">>();

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedQuery = fixture.scopedQuery;
});

afterEach(async () => {
  if (generatedRunIds.size === 0) {
    return;
  }
  await testDb
    .delete(pdfAnonymizationRuns)
    .where(inArray(pdfAnonymizationRuns.id, [...generatedRunIds]));
  generatedRunIds.clear();
});

afterAll(releaseRlsFixture);

const runValues = () => {
  const id = createSafeId<"pdfAnonymizationRun">();
  generatedRunIds.add(id);
  return {
    id,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    entityId: ids.entityA1,
    entityVersionId: ids.entityVersionA1,
    fileFieldId: ids.fileFieldA1,
    sourceFileId: toSafeId<"userFile">(ids.fileObjectA1),
    sourceFileName: "legal-document.pdf",
    sourceMimeType: PDF_MIME_TYPE,
    sourceSha256Hex: "a".repeat(64),
    requestedBy: ids.userA1,
  } satisfies typeof pdfAnonymizationRuns.$inferInsert;
};

const expectRlsDenied = async (operation: () => Promise<unknown>) => {
  const result = await Result.tryPromise({
    try: operation,
    catch: (error) => error,
  });
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(isPgError(result.error, PG_ERROR.INSUFFICIENT_PRIVILEGE)).toBe(true);
  }
};

const deniedScopes = [
  {
    name: "another workspace in the same organization",
    scope: () => ({ workspaces: [ids.wsA2], organization: ids.orgA }),
  },
  {
    name: "another organization",
    scope: () => ({ workspaces: [ids.wsB1], organization: ids.orgB }),
  },
  {
    name: "the source workspace with another organization",
    scope: () => ({ workspaces: [ids.wsA1], organization: ids.orgB }),
  },
  {
    name: "no authorized workspaces",
    scope: () => ({ workspaces: [], organization: ids.orgA }),
  },
];

describe("PDF anonymization run tenant isolation", () => {
  test("the source workspace can create, read, update, and delete a run", async () => {
    const values = runValues();
    await scopedQuery(
      [ids.wsA1],
      ids.orgA,
      async (tx) => {
        const inserted = await tx
          .insert(pdfAnonymizationRuns)
          .values(values)
          .returning();
        expect(inserted).toHaveLength(1);
        expect(inserted.at(0)?.status).toBe("queued");
        const selected = await tx
          .select()
          .from(pdfAnonymizationRuns)
          .where(eq(pdfAnonymizationRuns.id, values.id));
        expect(selected.at(0)?.sourceSha256Hex).toBe(values.sourceSha256Hex);
        const updated = await tx
          .update(pdfAnonymizationRuns)
          .set({ status: "running" })
          .where(eq(pdfAnonymizationRuns.id, values.id))
          .returning();
        expect(updated.at(0)?.status).toBe("running");
        const deleted = await tx
          .delete(pdfAnonymizationRuns)
          .where(eq(pdfAnonymizationRuns.id, values.id))
          .returning();
        expect(deleted.map(({ id }) => id)).toEqual([values.id]);
      },
      ids.userA1,
    );
    expect(
      await testDb.$count(
        pdfAnonymizationRuns,
        eq(pdfAnonymizationRuns.id, values.id),
      ),
    ).toBe(0);
  });

  test.each(deniedScopes)(
    "$name cannot read, update, or delete a source run",
    async ({ scope }) => {
      const values = runValues();
      await testDb.insert(pdfAnonymizationRuns).values(values);
      const { workspaces, organization } = scope();
      await scopedQuery(
        workspaces,
        organization,
        async (tx) => {
          expect(
            await tx
              .select()
              .from(pdfAnonymizationRuns)
              .where(eq(pdfAnonymizationRuns.id, values.id)),
          ).toEqual([]);
          expect(
            await tx
              .update(pdfAnonymizationRuns)
              .set({ status: "failed" })
              .where(eq(pdfAnonymizationRuns.id, values.id))
              .returning(),
          ).toEqual([]);
          expect(
            await tx
              .delete(pdfAnonymizationRuns)
              .where(eq(pdfAnonymizationRuns.id, values.id))
              .returning(),
          ).toEqual([]);
        },
        ids.userA1,
      );
      const retained = await testDb
        .select()
        .from(pdfAnonymizationRuns)
        .where(eq(pdfAnonymizationRuns.id, values.id));
      expect(retained).toHaveLength(1);
      expect(retained.at(0)?.status).toBe("queued");
    },
  );

  test.each(deniedScopes)(
    "$name cannot create a source run",
    async ({ scope }) => {
      const values = runValues();
      const { workspaces, organization } = scope();
      await expectRlsDenied(() =>
        scopedQuery(
          workspaces,
          organization,
          async (tx) => {
            await tx.insert(pdfAnonymizationRuns).values(values);
          },
          ids.userA1,
        ),
      );
      expect(
        await testDb.$count(
          pdfAnonymizationRuns,
          eq(pdfAnonymizationRuns.id, values.id),
        ),
      ).toBe(0);
    },
  );
  test("an authorized run cannot be moved into a foreign tenant", async () => {
    const values = runValues();
    await testDb.insert(pdfAnonymizationRuns).values(values);
    await expectRlsDenied(() =>
      scopedQuery(
        [ids.wsA1],
        ids.orgA,
        async (tx) => {
          await tx
            .update(pdfAnonymizationRuns)
            .set({
              organizationId: ids.orgB,
              workspaceId: ids.wsB1,
              entityId: ids.entityB1,
              entityVersionId: ids.entityVersionB1,
              fileFieldId: ids.fileFieldB1,
              sourceFileId: toSafeId<"userFile">(ids.fileObjectB1),
            })
            .where(eq(pdfAnonymizationRuns.id, values.id));
        },
        ids.userA1,
      ),
    );
    const retained = await testDb
      .select()
      .from(pdfAnonymizationRuns)
      .where(eq(pdfAnonymizationRuns.id, values.id));
    expect(retained.at(0)?.workspaceId).toBe(ids.wsA1);
    expect(retained.at(0)?.organizationId).toBe(ids.orgA);
  });
});
