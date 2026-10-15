// The STELLA_RUN_POSTGRES_TESTS runner also executes this verification suite.
/**
 * A verification pins its facts by value when it starts, each with the
 * sources that say where it comes from and the name each source document had
 * then, so a finished run still reads the same after the list or its
 * documents change.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { inArray, sql } from "drizzle-orm";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";

import { organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  entities,
  entityVersions,
  legalListFactDetails,
  legalListItemSources,
  legalListItems,
  legalLists,
  workspaces,
} from "@/api/db/schema";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { readVerificationEvidence } from "@/api/lib/lists/verification/evidence";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
const userId = toSafeId<"user">(`user_${Bun.randomUUIDv7()}`);
const workspaceId = createSafeId<"workspace">();
const listId = createSafeId<"legalList">();
const signedFactId = createSafeId<"entity">();
const heldFactId = createSafeId<"entity">();
const emailDocumentId = createSafeId<"entity">();
const emailVersionId = createSafeId<"entityVersion">();
const minutesDocumentId = createSafeId<"entity">();
const minutesVersionId = createSafeId<"entityVersion">();

beforeAll(
  async () => {
    testDb = await getTestDb();
    await testDb.transaction(async (tx: TestDatabaseTransaction) => {
      await tx.execute(sql.raw("RESET ROLE"));
      await tx.insert(organization).values({
        id: organizationId,
        name: "Evidence firm",
        slug: `evidence-${Bun.randomUUIDv7()}`,
        createdAt: new Date(),
      });
      await tx.insert(user).values({
        id: userId,
        name: "Evidence User",
        email: `${userId}@example.test`,
      });
      await tx.insert(workspaces).values({
        id: workspaceId,
        organizationId,
        name: "Evidence matter",
        reference: Bun.randomUUIDv7().slice(0, 8),
      });
      await tx.insert(legalLists).values({
        id: listId,
        workspaceId,
        name: "Chronology",
        status: "active",
        createdBy: userId,
      });

      const facts = [
        { id: signedFactId, name: "Contract signed", position: "a" },
        { id: heldFactId, name: "Meeting at the warehouse", position: "b" },
      ];
      await tx.insert(entities).values([
        ...facts.map((fact) => ({
          id: fact.id,
          workspaceId,
          kind: "task" as const,
          listItemType: LIST_ITEM_TYPE.FACT,
          name: fact.name,
          createdBy: userId,
          agendaKind: "task" as const,
          status: "open" as const,
          priority: "none" as const,
          agendaSource: "manual" as const,
        })),
        {
          id: emailDocumentId,
          workspaceId,
          kind: "document" as const,
          name: "Email bundle.pdf",
          createdBy: userId,
        },
        {
          id: minutesDocumentId,
          workspaceId,
          kind: "document" as const,
          name: "Board minutes.docx",
          createdBy: userId,
        },
      ]);
      await tx.insert(entityVersions).values([
        { id: emailVersionId, workspaceId, entityId: emailDocumentId },
        { id: minutesVersionId, workspaceId, entityId: minutesDocumentId },
      ]);
      await tx.insert(legalListItems).values(
        facts.map((fact) => ({
          entityId: fact.id,
          workspaceId,
          listId,
          position: fact.position,
          addedBy: userId,
        })),
      );
      await tx.insert(legalListFactDetails).values({
        itemEntityId: heldFactId,
        workspaceId,
        listId,
        confidence: "low",
        scoring: "held",
      });

      const email = {
        sourceEntityId: emailDocumentId,
        sourceEntityVersionId: emailVersionId,
      };
      const minutes = {
        sourceEntityId: minutesDocumentId,
        sourceEntityVersionId: minutesVersionId,
      };
      const itemSource = (
        itemEntityId: SafeId<"entity">,
        createdAt: string,
        values: Pick<
          typeof legalListItemSources.$inferInsert,
          | "sourceEntityId"
          | "sourceEntityVersionId"
          | "locator"
          | "quote"
          | "verificationStatus"
        >,
      ): typeof legalListItemSources.$inferInsert => ({
        id: createSafeId<"legalListItemSource">(),
        workspaceId,
        listId,
        itemEntityId,
        createdAt: new Date(createdAt),
        createdBy: userId,
        ...values,
      });
      await tx.insert(legalListItemSources).values([
        itemSource(signedFactId, "2026-01-02T00:00:00Z", {
          ...minutes,
          locator: { type: "docx-block", blockId: "p4" },
          quote: "The parties signed on 1 July 2021.",
          verificationStatus: "verified",
        }),
        itemSource(signedFactId, "2026-01-01T00:00:00Z", {
          ...email,
          locator: { type: "pdf-page", pageNumber: 488 },
          quote: null,
          verificationStatus: "unverified",
        }),
        itemSource(signedFactId, "2026-01-03T00:00:00Z", {
          ...email,
          locator: { type: "pdf-page", pageNumber: 12 },
          quote: null,
          verificationStatus: "rejected",
        }),
        itemSource(heldFactId, "2026-01-01T00:00:00Z", {
          ...email,
          locator: { type: "document" },
          quote: null,
          verificationStatus: "unverified",
        }),
      ]);
    });
  },
  { timeout: 30_000 },
);

afterAll(async () => {
  await testDb
    .delete(organization)
    .where(inArray(organization.id, [organizationId]));
  await releaseTestDb();
});

const readEvidence = async () =>
  await testDb.transaction(async (tx: TestDatabaseTransaction) => {
    await tx.execute(sql.raw("RESET ROLE"));
    return await readVerificationEvidence({
      tx: asTestRaw<Transaction>(tx),
      workspaceId,
      listId,
    });
  });

test("pins standing sources with their document names, oldest first", async () => {
  const outcome = await readEvidence();
  if (outcome.type !== "read") {
    throw new Error(`expected evidence, got ${outcome.type}`);
  }
  expect(outcome.evidence.facts.map((fact) => fact.factEntityId)).toEqual([
    signedFactId,
  ]);
  expect(outcome.evidence.facts.at(0)?.sources).toEqual([
    {
      sourceEntityId: emailDocumentId,
      sourceEntityVersionId: emailVersionId,
      sourceName: "Email bundle.pdf",
      locator: { type: "pdf-page", pageNumber: 488 },
      quote: null,
    },
    {
      sourceEntityId: minutesDocumentId,
      sourceEntityVersionId: minutesVersionId,
      sourceName: "Board minutes.docx",
      locator: { type: "docx-block", blockId: "p4" },
      quote: "The parties signed on 1 July 2021.",
    },
  ]);
});
