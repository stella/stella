import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import {
  entities,
  entityVersions,
  fields,
  properties,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import listFiles from "@/api/handlers/entities/files/list";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { PDF_MIME_TYPE } from "@/api/mime-types";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let db: TestDatabase;
const organizationId = mintAuthProviderId<"organization">();
const matterId = createSafeId<"workspace">();
const otherMatterId = createSafeId<"workspace">();

type SeededDocument = { name: string; fileName: string };

const seedDocument = async (
  workspaceId: SafeId<"workspace">,
  { name, fileName }: SeededDocument,
) => {
  const entityId = createSafeId<"entity">();
  const versionId = createSafeId<"entityVersion">();
  const propertyId = createSafeId<"property">();
  await db
    .insert(entities)
    .values({ id: entityId, workspaceId, kind: "document", name });
  await db
    .insert(entityVersions)
    .values({ id: versionId, entityId, workspaceId });
  await db.insert(properties).values({
    id: propertyId,
    workspaceId,
    name: "File",
    status: "fresh",
    content: { version: 1, type: "file" },
    tool: { version: 1, type: "manual-input" },
  });
  await db.insert(fields).values({
    id: createSafeId<"field">(),
    workspaceId,
    entityVersionId: versionId,
    propertyId,
    content: {
      version: 1,
      type: "file",
      id: Bun.randomUUIDv7(),
      fileName,
      mimeType: PDF_MIME_TYPE,
      sizeBytes: 1,
      encrypted: false,
      sha256Hex: "a".repeat(64),
      pdfFileId: null,
    },
  });
  await db
    .update(entities)
    .set({ currentVersionId: versionId })
    .where(eq(entities.id, entityId));
};

beforeAll(async () => {
  db = await getTestDb();
  await db.insert(organization).values({
    id: organizationId,
    name: "File search",
    slug: organizationId,
    createdAt: new Date(),
  });
  await db.insert(workspaces).values([
    {
      id: matterId,
      organizationId,
      name: "Matter",
      reference: matterId,
    },
    {
      id: otherMatterId,
      organizationId,
      name: "Other matter",
      reference: otherMatterId,
    },
  ]);
  // Seeded in creation order, which is the list's order.
  for (const document of [
    { name: "Kupní smlouva", fileName: "Kupní smlouva.docx" },
    { name: "Signed engagement", fileName: "scan-0042.pdf" },
    { name: "Side letter", fileName: "Side Letter.pdf" },
    { name: "Draft", fileName: "100%_final.pdf" },
    { name: "Smlouva o dílo", fileName: "Smlouva o dílo.docx" },
  ]) {
    await seedDocument(matterId, document);
  }
  await seedDocument(otherMatterId, {
    name: "Kupní smlouva",
    fileName: "Kupní smlouva (other).docx",
  });
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, organizationId));
  await releaseTestDb();
});

const listFileNames = async (query: {
  search?: string;
  limit?: number;
  cursor?: string;
}) => {
  const result = await listFiles.handler(
    createTestHandlerContext<Parameters<typeof listFiles.handler>[0]>({
      workspaceId: matterId,
      session: { activeOrganizationId: organizationId },
      // Both matters are readable, so only the handler's own matter predicate
      // keeps the other matter's files out.
      safeDb: createSafeDb(db, [matterId, otherMatterId], organizationId, null),
      scopedDb: NO_DB,
      audit: NO_AUDIT,
      query,
    }),
  );
  if (!("items" in result)) {
    return panic("Listing the matter's files failed", { cause: result });
  }
  return {
    fileNames: result.items.map(({ fileName }) => fileName),
    nextCursor: result.nextCursor,
  };
};

test("search matches the file name ignoring case and accents, in this matter only", async () => {
  expect((await listFileNames({ search: "KUPNI" })).fileNames).toEqual([
    "Kupní smlouva.docx",
  ]);
  expect((await listFileNames({ search: "smlouva" })).fileNames).toEqual([
    "Kupní smlouva.docx",
    "Smlouva o dílo.docx",
  ]);
});

test("search matches the document name when the file name does not carry it", async () => {
  expect((await listFileNames({ search: "engagement" })).fileNames).toEqual([
    "scan-0042.pdf",
  ]);
});

test("search treats LIKE wildcards as literal text", async () => {
  expect((await listFileNames({ search: "%_" })).fileNames).toEqual([
    "100%_final.pdf",
  ]);
});

test("a blank search lists every file in the matter", async () => {
  expect((await listFileNames({ search: "  " })).fileNames).toEqual([
    "Kupní smlouva.docx",
    "scan-0042.pdf",
    "Side Letter.pdf",
    "100%_final.pdf",
    "Smlouva o dílo.docx",
  ]);
});

test("a search pages by cursor over its matches", async () => {
  const first = await listFileNames({ search: "smlouva", limit: 1 });
  expect(first.fileNames).toEqual(["Kupní smlouva.docx"]);
  const cursor =
    first.nextCursor ??
    panic("The first page of two matches has no next cursor");
  const second = await listFileNames({
    search: "smlouva",
    limit: 1,
    cursor,
  });
  expect(second).toEqual({
    fileNames: ["Smlouva o dílo.docx"],
    nextCursor: null,
  });
});
