import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  cellMetadata,
  fields,
  justifications,
  properties,
} from "@/api/db/schema";
import type { JustificationContent } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  type CellCompanionRows,
  planCellCompanions,
} from "@/api/lib/entity-versions/cell-companions";
import { insertEntityVersion } from "@/api/lib/entity-versions/insert-entity-version";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  await releaseRlsFixture();
});

class RolledBackError extends Error {
  override name = "RolledBackError";
}

/** Run `body` in a transaction that never commits. */
const inRolledBackTransaction = async (
  body: (tx: TestDatabaseTransaction) => Promise<void>,
) => {
  const outcome = await testDb
    .transaction(async (tx: TestDatabaseTransaction) => {
      await tx.execute(sql.raw("RESET ROLE"));
      await body(tx);
      throw new RolledBackError();
    })
    .catch((error: unknown) => error);
  if (!(outcome instanceof RolledBackError)) {
    throw outcome;
  }
};

const citation = (fileFieldId: SafeId<"field">): JustificationContent => ({
  version: 1,
  blocks: [
    {
      kind: "pdf-bates",
      fileFieldId,
      statements: [
        {
          text: "Signed in Prague",
          citations: [{ bates: "A-1", pageNumber: 1 }],
        },
      ],
    },
  ],
});

/** A source cell with a lock and a citation, and a fresh version whose cells clone it. */
const seedClone = async (tx: TestDatabaseTransaction) => {
  // The shared fixture seeds its own; this transaction replaces them and rolls back.
  await tx
    .delete(justifications)
    .where(eq(justifications.workspaceId, ids.wsA1));
  await tx
    .delete(cellMetadata)
    .where(eq(cellMetadata.entityVersionId, ids.entityVersionA1));
  await tx.insert(cellMetadata).values({
    workspaceId: ids.wsA1,
    entityVersionId: ids.entityVersionA1,
    propertyId: ids.propertyA1,
    metadata: { version: 1, manualFlags: [], locked: true },
  });
  await tx.insert(justifications).values({
    id: createSafeId<"justification">(),
    workspaceId: ids.wsA1,
    fieldId: ids.fieldA1,
    content: citation(ids.fileFieldA1),
    fileFieldIds: [ids.fileFieldA1],
  });
  const targetVersionId = createSafeId<"entityVersion">();
  await insertEntityVersion(asTestRaw<Transaction>(tx), {
    createdBy: null,
    entityId: ids.entityA1,
    id: targetVersionId,
    label: null,
    stamp: null,
    versionNumber: 90,
    workspaceId: ids.wsA1,
  });
  const fieldClones = new Map([
    [ids.fieldA1, createSafeId<"field">()],
    [ids.fileFieldA1, createSafeId<"field">()],
  ]);
  const sources = await tx
    .select({
      id: fields.id,
      propertyId: fields.propertyId,
      content: fields.content,
    })
    .from(fields)
    .where(eq(fields.entityVersionId, ids.entityVersionA1));
  await tx.insert(fields).values(
    sources.map((source) => ({
      id: fieldClones.get(source.id) ?? createSafeId<"field">(),
      workspaceId: ids.wsA1,
      entityVersionId: targetVersionId,
      propertyId: source.propertyId,
      content: source.content,
    })),
  );
  return { targetVersionId, fieldClones };
};

const writeCompanions = async (
  tx: TestDatabaseTransaction,
  { metadata, justifications: cited }: CellCompanionRows,
) => {
  if (metadata.length > 0) {
    await tx.insert(cellMetadata).values(metadata);
  }
  if (cited.length > 0) {
    await tx.insert(justifications).values(cited);
  }
};

const lockOf = async (
  tx: TestDatabaseTransaction,
  entityVersionId: SafeId<"entityVersion">,
  propertyId: SafeId<"property">,
) =>
  (
    await tx
      .select({ metadata: cellMetadata.metadata })
      .from(cellMetadata)
      .where(
        and(
          eq(cellMetadata.entityVersionId, entityVersionId),
          eq(cellMetadata.propertyId, propertyId),
        ),
      )
  ).at(0)?.metadata.locked;

describe("cell companions across a clone", () => {
  test("a restore carries the lock and moves the citation onto the cloned cells", async () => {
    await inRolledBackTransaction(async (tx) => {
      const { targetVersionId, fieldClones } = await seedClone(tx);
      const clonedText = fieldClones.get(ids.fieldA1);
      const clonedFile = fieldClones.get(ids.fileFieldA1);

      const companions = await planCellCompanions({
        tx: asTestRaw<Transaction>(tx),
        kind: "restore",
        sourceWorkspaceId: ids.wsA1,
        targetWorkspaceId: ids.wsA1,
        versions: [{ sourceVersionId: ids.entityVersionA1, targetVersionId }],
        fieldClones,
      });
      await writeCompanions(tx, companions);

      expect(await lockOf(tx, targetVersionId, ids.propertyA1)).toBe(true);
      const carried = await tx
        .select({
          content: justifications.content,
          fileFieldIds: justifications.fileFieldIds,
        })
        .from(justifications)
        .where(eq(justifications.fieldId, clonedText ?? ids.fieldA1));
      expect(carried).toEqual([
        {
          content: citation(clonedFile ?? ids.fileFieldA1),
          fileFieldIds: [clonedFile ?? ids.fileFieldA1],
        },
      ]);
    });
  });

  test("a desktop edit keeps locks but leaves citations and the replaced cell behind", async () => {
    await inRolledBackTransaction(async (tx) => {
      const { targetVersionId, fieldClones } = await seedClone(tx);
      await tx.insert(cellMetadata).values({
        workspaceId: ids.wsA1,
        entityVersionId: ids.entityVersionA1,
        propertyId: ids.filePropertyA1,
        metadata: { version: 1, manualFlags: [], locked: true },
      });

      const companions = await planCellCompanions({
        tx: asTestRaw<Transaction>(tx),
        kind: "desktop-edit",
        sourceWorkspaceId: ids.wsA1,
        targetWorkspaceId: ids.wsA1,
        versions: [{ sourceVersionId: ids.entityVersionA1, targetVersionId }],
        replacedPropertyIds: [ids.filePropertyA1],
      });
      expect(companions.justifications).toEqual([]);
      await writeCompanions(tx, companions);

      expect(await lockOf(tx, targetVersionId, ids.propertyA1)).toBe(true);
      expect(
        await lockOf(tx, targetVersionId, ids.filePropertyA1),
      ).toBeUndefined();
      const carried = await tx
        .select({ id: justifications.id })
        .from(justifications)
        .where(
          eq(
            justifications.fieldId,
            fieldClones.get(ids.fieldA1) ?? ids.fieldA1,
          ),
        );
      expect(carried).toEqual([]);
    });
  });

  test("a clone into another matter maps each lock onto the target's property", async () => {
    await inRolledBackTransaction(async (tx) => {
      const { targetVersionId, fieldClones } = await seedClone(tx);
      await tx.insert(cellMetadata).values({
        workspaceId: ids.wsA1,
        entityVersionId: ids.entityVersionA1,
        propertyId: ids.filePropertyA1,
        metadata: { version: 1, manualFlags: [], locked: true },
      });
      const targetPropertyId = createSafeId<"property">();
      await tx.insert(properties).values({
        id: targetPropertyId,
        workspaceId: ids.wsA1,
        name: "Counterpart",
        content: { version: 1, type: "text" },
        tool: { version: 1, type: "manual-input" },
        status: "fresh",
      });

      const companions = await planCellCompanions({
        tx: asTestRaw<Transaction>(tx),
        kind: "copy",
        sourceWorkspaceId: ids.wsA1,
        targetWorkspaceId: ids.wsA1,
        versions: [{ sourceVersionId: ids.entityVersionA1, targetVersionId }],
        fieldClones,
        // The file property has no counterpart in the target.
        propertyIds: new Map([[ids.propertyA1, targetPropertyId]]),
      });

      expect(companions.metadata.map(({ propertyId }) => propertyId)).toEqual([
        targetPropertyId,
      ]);
      await writeCompanions(tx, companions);
      expect(await lockOf(tx, targetVersionId, targetPropertyId)).toBe(true);
    });
  });
});
