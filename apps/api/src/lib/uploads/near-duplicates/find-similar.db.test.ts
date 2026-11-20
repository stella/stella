import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import type { SafeDb } from "@/api/db/safe-db";
import {
  entities,
  entityVersionMinhashBands,
  entityVersionMinhashSignatures,
  entityVersions,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { findSimilarDocuments } from "@/api/lib/uploads/near-duplicates/find-similar";
import {
  LSH_BANDS,
  NEAR_DUPLICATE_THRESHOLD,
} from "@/api/lib/uploads/near-duplicates/minhash";
import { recordNearDuplicateSignature } from "@/api/lib/uploads/near-duplicates/record-signature";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let db: TestDatabase;
const organizationId = mintAuthProviderId<"organization">();
const userId = mintAuthProviderId<"user">();
const matterId = createSafeId<"workspace">();
const otherMatterId = createSafeId<"workspace">();
let docSequence = 0;

const CONTRACT = [
  "The Supplier shall deliver the Goods to the Delivery Address on the Delivery Date stated in the Order.",
  "Risk in the Goods passes to the Customer on completion of delivery, and title passes on payment in full.",
  "The Customer shall pay each invoice within thirty days of its date by transfer to the account the Supplier names.",
  "Either party may terminate this Agreement by written notice if the other commits a material breach it does not remedy within fourteen days.",
  "Neither party limits its liability for death or personal injury caused by its negligence, or for fraud.",
  "This Agreement is governed by the law of England and Wales and the courts of London have exclusive jurisdiction.",
  "Any notice under this Agreement must be in writing and delivered by hand, by recorded post or by email to the address in the Schedule.",
  "The Supplier warrants that the Goods conform to their description, are of satisfactory quality and are fit for any stated purpose.",
].join("\n\n");
const EDITED = CONTRACT.replace("thirty days", "sixty days");
const UNRELATED = Array.from(
  { length: 80 },
  (_, index) =>
    `minute ${index} of the board meeting recorded item ${index * 7}`,
).join(" ");

/** An entity with one version per text; the last is the current one. */
const seedDocument = async (
  workspaceId: SafeId<"workspace">,
  name: string,
  texts: readonly string[],
): Promise<SafeId<"entity">> => {
  const entityId = createSafeId<"entity">();
  const versionIds = texts.map(() => createSafeId<"entityVersion">());
  await db.insert(entities).values({
    id: entityId,
    workspaceId,
    kind: "document",
    name,
    docSequence: ++docSequence,
  });
  await db.insert(entityVersions).values(
    versionIds.map((id, index) => ({
      id,
      entityId,
      workspaceId,
      versionNumber: index + 1,
    })),
  );
  for (const [index, text] of texts.entries()) {
    await recordNearDuplicateSignature(
      asTestRaw<Parameters<typeof recordNearDuplicateSignature>[0]>(db),
      {
        entityId,
        entityVersionId: versionIds[index] ?? createSafeId<"entityVersion">(),
        organizationId,
        workspaceId,
        text,
      },
    );
  }
  await db
    .update(entities)
    .set({ currentVersionId: versionIds.at(-1) })
    .where(eq(entities.id, entityId));
  return entityId;
};

const find = async (
  access: readonly SafeId<"workspace">[],
  workspaceId: SafeId<"workspace">,
  entityId: SafeId<"entity">,
) => {
  const safeDb = asTestRaw<SafeDb>(
    createSafeDb(db, [...access], organizationId, userId),
  );
  const result = await safeDb(
    async (tx) => await findSimilarDocuments({ tx, workspaceId, entityId }),
  );
  return result.unwrap().map(({ entityName }) => entityName);
};

let contractId: SafeId<"entity">;
let revisedId: SafeId<"entity">;

beforeAll(async () => {
  db = await getTestDb();
  await db.insert(organization).values({
    id: organizationId,
    name: "Near duplicates",
    slug: organizationId,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  });
  await db.insert(user).values({
    id: userId,
    name: "Near Duplicates User",
    email: `${userId}@example.test`,
  });
  await db.insert(workspaces).values([
    { id: matterId, organizationId, name: "Matter", reference: "NEAR-1" },
    { id: otherMatterId, organizationId, name: "Other", reference: "NEAR-2" },
  ]);
  contractId = await seedDocument(matterId, "Contract.docx", [CONTRACT]);
  await seedDocument(matterId, "Contract signed.pdf", [EDITED]);
  await seedDocument(matterId, "Board minutes.pdf", [UNRELATED]);
  await seedDocument(matterId, "Superseded.pdf", [CONTRACT, UNRELATED]);
  revisedId = await seedDocument(matterId, "Revised.docx", [EDITED, UNRELATED]);
  await seedDocument(otherMatterId, "Contract copy.docx", [CONTRACT]);
});

afterAll(async () => {
  await deleteOrganizationsForTest(db, [organizationId]);
  await db.delete(user).where(inArray(user.id, [userId]));
  await releaseTestDb();
});

test("an edited copy in the same matter is reported above the threshold", async () => {
  const safeDb = asTestRaw<SafeDb>(
    createSafeDb(db, [matterId], organizationId, userId),
  );
  const result = (
    await safeDb(
      async (tx) =>
        await findSimilarDocuments({
          tx,
          workspaceId: matterId,
          entityId: contractId,
        }),
    )
  ).unwrap();
  expect(result.map(({ entityName }) => entityName)).toEqual([
    "Contract signed.pdf",
  ]);
  expect(result[0]?.similarity).toBeGreaterThanOrEqual(
    NEAR_DUPLICATE_THRESHOLD,
  );
});

test("an older version of the same document is never reported", async () => {
  expect(await find([matterId], matterId, revisedId)).toEqual([
    "Board minutes.pdf",
    "Superseded.pdf",
  ]);
});

test("a document in another matter is never reported", async () => {
  expect(await find([matterId, otherMatterId], matterId, contractId)).toEqual([
    "Contract signed.pdf",
  ]);
});

test("a user without access to the matter learns nothing about it", async () => {
  expect(await find([otherMatterId], matterId, contractId)).toEqual([]);
});

test("a redelivered extraction leaves one signature and its band keys", async () => {
  const [version] = await db
    .select({ id: entities.currentVersionId })
    .from(entities)
    .where(eq(entities.id, contractId));
  const entityVersionId = version?.id ?? createSafeId<"entityVersion">();
  await recordNearDuplicateSignature(
    asTestRaw<Parameters<typeof recordNearDuplicateSignature>[0]>(db),
    {
      entityId: contractId,
      entityVersionId,
      organizationId,
      workspaceId: matterId,
      text: CONTRACT,
    },
  );
  const bands = await db
    .select()
    .from(entityVersionMinhashBands)
    .where(eq(entityVersionMinhashBands.entityVersionId, entityVersionId));
  expect(bands).toHaveLength(LSH_BANDS);
});

test("deleting a version deletes its signature and band keys", async () => {
  const entityId = await seedDocument(matterId, "Draft.docx", [CONTRACT]);
  const [version] = await db
    .select({ id: entities.currentVersionId })
    .from(entities)
    .where(eq(entities.id, entityId));
  const entityVersionId = version?.id ?? createSafeId<"entityVersion">();
  await db.delete(entities).where(eq(entities.id, entityId));
  expect(
    await db
      .select()
      .from(entityVersionMinhashSignatures)
      .where(
        eq(entityVersionMinhashSignatures.entityVersionId, entityVersionId),
      ),
  ).toEqual([]);
  expect(
    await db
      .select()
      .from(entityVersionMinhashBands)
      .where(eq(entityVersionMinhashBands.entityVersionId, entityVersionId)),
  ).toEqual([]);
});
