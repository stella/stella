import { PDF } from "@libpdf/core";
import { panic } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { MATTER_DOCUMENT_ANNOTATION_REFUSALS } from "@stll/api-contract/legal-reader-annotations";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  auditLogs,
  entities,
  entityVersions,
  fields,
  legalReaderAnnotations,
  properties,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { envBase } from "@/api/env-base";
import createDocumentAnnotation from "@/api/handlers/entities/annotations/create";
import deleteDocumentAnnotation from "@/api/handlers/entities/annotations/delete";
import listDocumentAnnotations from "@/api/handlers/entities/annotations/list";
import updateDocumentAnnotation from "@/api/handlers/entities/annotations/update";
import { readAccountExportAnnotationPage } from "@/api/lib/account-export/owner-read";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditRecorder,
} from "@/api/lib/audit-log";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  pdfPageTextSha256,
  readPdfPageTexts,
} from "@/api/lib/files/pdf-page-text";
import { createFileKey } from "@/api/lib/files/utils";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const FIRST_VERSION_PAGES = [
  "Purchase agreement between the parties",
  "The seller shall deliver the goods within thirty days.",
  "",
] as const;
const SECOND_VERSION_PAGES = [
  "Purchase agreement between the parties",
  "The seller shall deliver the goods within sixty days.",
] as const;
const QUOTE = "deliver the goods";
const COMMENT = "Check the delivery term against the order form.";

let fakeS3: FakeS3;

beforeEach(() => {
  fakeS3 = startFakeS3();
});

afterEach(() => {
  fakeS3.stop();
});

/** One drawn line per page; an empty entry is a page without a text layer. */
const pdfWithPages = async (pages: readonly string[]): Promise<Uint8Array> => {
  const pdf = PDF.create();
  for (const text of pages) {
    const page = pdf.addPage({ size: "letter" });
    if (text !== "") {
      page.drawText(text, { x: 72, y: 700, size: 12 });
    }
  }
  return await pdf.save();
};

type DocumentFile = {
  fieldId: SafeId<"field">;
  versionId: SafeId<"entityVersion">;
  /** The pages as the extractor reads them, by 1-based number. */
  pageTexts: Map<number, string>;
};

type Tenant = {
  organizationId: SafeId<"organization">;
  author: SafeId<"user">;
  colleague: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
  otherWorkspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  propertyId: SafeId<"property">;
  first: DocumentFile;
};

type AddFileOptions = {
  content?: (fileId: string) => Record<string, unknown>;
  pages: readonly string[];
  propertyId?: SafeId<"property">;
  versionNumber: number;
};

/** A new version of the tenant's document holding one file field. */
const addVersionFile = async (
  db: GatedTestDb,
  tenant: Pick<
    Tenant,
    "entityId" | "organizationId" | "propertyId" | "workspaceId"
  >,
  {
    content,
    pages,
    propertyId = tenant.propertyId,
    versionNumber,
  }: AddFileOptions,
): Promise<DocumentFile> => {
  const versionId = createSafeId<"entityVersion">();
  const fieldId = createSafeId<"field">();
  const fileId = Bun.randomUUIDv7();
  const bytes = await pdfWithPages(pages);
  fakeS3.put(
    envBase.S3_BUCKET,
    createFileKey({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      fileId,
      mimeType: PDF_MIME_TYPE,
    }),
    bytes,
    PDF_MIME_TYPE,
  );
  await db.insert(entityVersions).values({
    id: versionId,
    entityId: tenant.entityId,
    workspaceId: tenant.workspaceId,
    versionNumber,
  });
  await db.insert(fields).values({
    id: fieldId,
    workspaceId: tenant.workspaceId,
    entityVersionId: versionId,
    propertyId,
    content: {
      version: 1,
      type: "file",
      id: fileId,
      fileName: "Purchase agreement.pdf",
      mimeType: PDF_MIME_TYPE,
      sizeBytes: bytes.byteLength,
      encrypted: false,
      sha256Hex: "b".repeat(64),
      pdfFileId: null,
      ...content?.(fileId),
    },
  });
  await db
    .update(entities)
    .set({ currentVersionId: versionId })
    .where(eq(entities.id, tenant.entityId));
  return {
    fieldId,
    versionId,
    pageTexts: new Map(
      (await readPdfPageTexts({ bytes })).map(({ pageNumber, text }) => [
        pageNumber,
        text,
      ]),
    ),
  };
};

const addProperty = async (
  db: GatedTestDb,
  workspaceId: SafeId<"workspace">,
): Promise<SafeId<"property">> => {
  const id = createSafeId<"property">();
  await db.insert(properties).values({
    id,
    workspaceId,
    name: "File",
    status: "fresh",
    content: { version: 1, type: "file" },
    tool: { version: 1, type: "manual-input" },
  });
  return id;
};

const seedTenant = async (db: GatedTestDb): Promise<Tenant> => {
  const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
  const author = toSafeId<"user">(`usr_${Bun.randomUUIDv7()}`);
  const colleague = toSafeId<"user">(`usr_${Bun.randomUUIDv7()}`);
  const workspaceId = createSafeId<"workspace">();
  const otherWorkspaceId = createSafeId<"workspace">();
  const entityId = createSafeId<"entity">();
  await db.insert(organization).values({
    id: organizationId,
    name: "Document mark firm",
    slug: organizationId,
    createdAt: new Date(),
  });
  await recordNewOrganizationAccessState(db, {
    organizationId,
    now: new Date(),
  });
  await db.insert(user).values(
    [author, colleague].map((id) => ({
      id,
      name: "Reviewer",
      email: `${id}@example.test`,
      emailVerified: true,
    })),
  );
  await db.insert(member).values(
    [author, colleague].map((userId) => ({
      id: Bun.randomUUIDv7(),
      userId,
      organizationId,
      role: "owner",
      createdAt: new Date(),
    })),
  );
  await db.insert(workspaces).values(
    [workspaceId, otherWorkspaceId].map((id) => ({
      id,
      organizationId,
      name: "Document mark matter",
      reference: id,
    })),
  );
  await db
    .insert(entities)
    .values({ id: entityId, workspaceId, name: "Purchase agreement" });
  const propertyId = await addProperty(db, workspaceId);
  const scope = { entityId, organizationId, propertyId, workspaceId };
  return {
    ...scope,
    author,
    colleague,
    otherWorkspaceId,
    first: await addVersionFile(db, scope, {
      pages: FIRST_VERSION_PAGES,
      versionNumber: 1,
    }),
  };
};

const contextFor = (
  db: GatedTestDb,
  tenant: Tenant,
  {
    organizationId = tenant.organizationId,
    userId = tenant.author,
    visibleWorkspaceIds = [tenant.workspaceId, tenant.otherWorkspaceId],
    workspaceId = tenant.workspaceId,
  }: {
    organizationId?: SafeId<"organization">;
    userId?: SafeId<"user">;
    visibleWorkspaceIds?: SafeId<"workspace">[];
    workspaceId?: SafeId<"workspace">;
  } = {},
) => ({
  scopedDb: NO_DB,
  workspaceId,
  session: { activeOrganizationId: organizationId },
  user: { id: userId },
  safeDb: createSafeDb(
    markRlsDatabase(db),
    visibleWorkspaceIds,
    organizationId,
    userId,
  ),
  audit: createAuditRecorder({
    organizationId,
    workspaceId,
    userId,
    request: new Request("https://example.test/document-annotations"),
    server: null,
  }),
});

type CallerOptions = Parameters<typeof contextFor>[2];

/** A span over `quote` on the page as the extractor reads it. */
const spanOn = (file: DocumentFile, pageNumber: number, quote = QUOTE) => {
  const text =
    file.pageTexts.get(pageNumber) ?? panic(`No page ${String(pageNumber)}`);
  const startOffset = text.indexOf(quote);
  if (startOffset === -1) {
    return panic(`"${quote}" is not on page ${String(pageNumber)}`);
  }
  return {
    pageNumber,
    startOffset,
    endOffset: startOffset + quote.length,
    quote,
  };
};

type CreateOptions = CallerOptions & {
  body?: Parameters<typeof createDocumentAnnotation.handler>[0]["body"];
  entityId?: SafeId<"entity">;
  fieldId?: SafeId<"field">;
};

const create = async (
  db: GatedTestDb,
  tenant: Tenant,
  { body, entityId = tenant.entityId, fieldId, ...caller }: CreateOptions = {},
) => {
  const context = contextFor(db, tenant, caller);
  return await createDocumentAnnotation.handler(
    createTestHandlerContext<
      Parameters<typeof createDocumentAnnotation.handler>[0]
    >({
      ...context,
      params: {
        workspaceId: context.workspaceId,
        entityId,
        fieldId: fieldId ?? tenant.first.fieldId,
      },
      body: body ?? {
        kind: "comment",
        body: COMMENT,
        spans: [spanOn(tenant.first, 2)],
      },
    }),
  );
};

const list = async (
  db: GatedTestDb,
  tenant: Tenant,
  {
    fieldId = tenant.first.fieldId,
    ...caller
  }: CallerOptions & { fieldId?: SafeId<"field"> } = {},
) => {
  const context = contextFor(db, tenant, caller);
  return await listDocumentAnnotations.handler(
    createTestHandlerContext<
      Parameters<typeof listDocumentAnnotations.handler>[0]
    >({
      ...context,
      params: {
        workspaceId: context.workspaceId,
        entityId: tenant.entityId,
        fieldId,
      },
      query: {},
    }),
  );
};

type ListedMark = {
  id: string;
  fieldId: string;
  pageNumber: number;
  pageTextSha256: string;
  quote: string;
  versionNumber: number;
};

const listed = (result: unknown): ListedMark[] => {
  if (
    typeof result !== "object" ||
    result === null ||
    !("items" in result) ||
    !Array.isArray(result.items)
  ) {
    return panic(`A mark page was expected: ${JSON.stringify(result)}`);
  }
  return result.items;
};

const createdId = (result: unknown): SafeId<"legalReaderAnnotation"> => {
  if (
    typeof result !== "object" ||
    result === null ||
    !("id" in result) ||
    typeof result.id !== "string"
  ) {
    return panic(`A created mark was expected: ${JSON.stringify(result)}`);
  }
  return toSafeId<"legalReaderAnnotation">(result.id);
};

const auditEvents = async (db: GatedTestDb, tenant: Tenant) =>
  await db
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.organizationId, tenant.organizationId),
        eq(auditLogs.resourceType, AUDIT_RESOURCE_TYPE.DOCUMENT_ANNOTATION),
      ),
    )
    .limit(20);

/** Every author's stored marks on the document, past any row policy. */
const storedMarks = async (db: GatedTestDb, tenant: Tenant) =>
  (
    await Promise.all(
      [tenant.author, tenant.colleague].map(
        async (userId) =>
          await readAccountExportAnnotationPage({
            database: db,
            organizationId: tenant.organizationId,
            userId,
            extraWhere: eq(legalReaderAnnotations.entityId, tenant.entityId),
            limit: 20,
          }),
      ),
    )
  ).flat();

const withTenant = async (
  exercise: (scope: { db: GatedTestDb; tenant: Tenant }) => Promise<void>,
) => {
  const databaseUrl =
    process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const db = openClient({ max: 4 }).db;
    const tenant = await seedTenant(db);
    try {
      await exercise({ db, tenant });
    } finally {
      await db
        .delete(organization)
        .where(eq(organization.id, tenant.organizationId));
      await db.delete(user).where(eq(user.id, tenant.author));
      await db.delete(user).where(eq(user.id, tenant.colleague));
    }
  });
};

describe.skipIf(!enabled)("marks on a matter document's PDF", () => {
  test("lists quote context together with the document version and page digest", async () =>
    await withTenant(async ({ db, tenant }) => {
      const id = createdId(await create(db, tenant));
      const quotePrefix = "The seller shall ";
      const quoteSuffix = " within thirty days.";
      await db
        .update(legalReaderAnnotations)
        .set({ quotePrefix, quoteSuffix })
        .where(eq(legalReaderAnnotations.id, id));

      expect(listed(await list(db, tenant))).toMatchObject([
        {
          id,
          fieldId: tenant.first.fieldId,
          versionNumber: 1,
          pageNumber: 2,
          pageTextSha256: pdfPageTextSha256(
            tenant.first.pageTexts.get(2) ?? panic("No page 2"),
          ),
          quote: QUOTE,
          quotePrefix,
          quoteSuffix,
        },
      ]);
    }));

  test("an author creates, lists, edits, shares and deletes a comment, each audited without its words", async () =>
    await withTenant(async ({ db, tenant }) => {
      const id = createdId(await create(db, tenant));
      const [stored] = await storedMarks(db, tenant);
      expect(stored).toMatchObject({
        id,
        targetType: "matter-document",
        targetId: tenant.first.fieldId,
        entityId: tenant.entityId,
        workspaceId: tenant.workspaceId,
        kind: "comment",
        body: COMMENT,
        visibility: "private",
        blockAnchorId: "page-2",
        quote: QUOTE,
        pageTextSha256: pdfPageTextSha256(
          tenant.first.pageTexts.get(2) ?? panic("No page 2"),
        ),
      });

      expect(listed(await list(db, tenant))).toMatchObject([
        {
          id,
          fieldId: tenant.first.fieldId,
          pageNumber: 2,
          quote: QUOTE,
          versionNumber: 1,
        },
      ]);
      // Private until shared: a colleague on the matter does not see it.
      expect(
        listed(await list(db, tenant, { userId: tenant.colleague })),
      ).toEqual([]);

      const update = async (
        body: Parameters<typeof updateDocumentAnnotation.handler>[0]["body"],
        userId = tenant.author,
      ) =>
        await updateDocumentAnnotation.handler(
          createTestHandlerContext<
            Parameters<typeof updateDocumentAnnotation.handler>[0]
          >({
            ...contextFor(db, tenant, { userId }),
            params: {
              workspaceId: tenant.workspaceId,
              entityId: tenant.entityId,
              annotationId: id,
            },
            body,
          }),
        );
      expect(await update({ change: "body", body: "Revised." })).toEqual({
        ok: true,
      });
      expect(
        await update({ change: "visibility", visibility: "shared" }),
      ).toEqual({ ok: true });
      expect(
        listed(await list(db, tenant, { userId: tenant.colleague })).map(
          (mark) => mark.id,
        ),
      ).toEqual([id]);
      // Only the author changes or removes a mark, shared or not.
      expect(
        await update(
          { change: "body", body: "Overwritten." },
          tenant.colleague,
        ),
      ).toMatchObject({ code: 404 });
      const removeAs = async (userId: SafeId<"user">) =>
        await deleteDocumentAnnotation.handler(
          createTestHandlerContext<
            Parameters<typeof deleteDocumentAnnotation.handler>[0]
          >({
            ...contextFor(db, tenant, { userId }),
            params: {
              workspaceId: tenant.workspaceId,
              entityId: tenant.entityId,
              annotationId: id,
            },
          }),
        );
      expect(await removeAs(tenant.colleague)).toMatchObject({ code: 404 });
      expect(await removeAs(tenant.author)).toEqual({ ok: true });
      expect(await storedMarks(db, tenant)).toHaveLength(0);

      const events = await auditEvents(db, tenant);
      expect(events.map((event) => event.action).toSorted()).toEqual(
        [
          AUDIT_ACTION.CREATE,
          AUDIT_ACTION.DELETE,
          AUDIT_ACTION.UPDATE,
          AUDIT_ACTION.UPDATE,
        ].toSorted(),
      );
      for (const event of events) {
        expect(event).toMatchObject({
          resourceId: id,
          workspaceId: tenant.workspaceId,
          userId: tenant.author,
        });
        // The trail names the mark and its file, never its words.
        expect(JSON.stringify(event)).not.toContain(COMMENT);
        expect(JSON.stringify(event)).not.toContain("Revised.");
        expect(JSON.stringify(event)).not.toContain(QUOTE);
      }
      expect(
        events.find((event) => event.action === AUDIT_ACTION.CREATE)?.metadata,
      ).toMatchObject({
        entityId: tenant.entityId,
        fieldId: tenant.first.fieldId,
        kind: "comment",
        spanCount: 1,
      });
    }));

  test("a passage over two pages is one mark of two rows, changed and removed as one", async () =>
    await withTenant(async ({ db, tenant }) => {
      const id = createdId(
        await create(db, tenant, {
          body: {
            kind: "highlight",
            color: "green",
            style: "highlight",
            spans: [
              spanOn(tenant.first, 1, "between the parties"),
              spanOn(tenant.first, 2, "The seller"),
            ],
          },
        }),
      );
      const marks = listed(await list(db, tenant));
      expect(marks.map((mark) => mark.pageNumber)).toEqual([1, 2]);
      const removed = await deleteDocumentAnnotation.handler(
        createTestHandlerContext<
          Parameters<typeof deleteDocumentAnnotation.handler>[0]
        >({
          ...contextFor(db, tenant),
          params: {
            workspaceId: tenant.workspaceId,
            entityId: tenant.entityId,
            annotationId: id,
          },
        }),
      );
      expect(removed).toEqual({ ok: true });
      expect(await storedMarks(db, tenant)).toHaveLength(0);
    }));

  test("resending a request id returns the mark it already made", async () =>
    await withTenant(async ({ db, tenant }) => {
      const requestId = createSafeId<"legalReaderAnnotation">();
      const body = {
        kind: "highlight" as const,
        color: "yellow" as const,
        style: "underline" as const,
        requestId,
        spans: [spanOn(tenant.first, 2)],
      };
      const first = createdId(await create(db, tenant, { body }));
      const replayed = createdId(await create(db, tenant, { body }));
      expect(replayed).toBe(first);
      expect(await storedMarks(db, tenant)).toHaveLength(1);
    }));

  test("words that are not the page's words are refused, and nothing is stored or audited", async () =>
    await withTenant(async ({ db, tenant }) => {
      const span = spanOn(tenant.first, 2);
      const refusals = [
        {
          span: { ...span, quote: "deliver the gold" },
          code: MATTER_DOCUMENT_ANNOTATION_REFUSALS.quoteMismatch,
        },
        {
          span: {
            ...span,
            startOffset: span.startOffset + 1,
            endOffset: span.endOffset + 1,
          },
          code: MATTER_DOCUMENT_ANNOTATION_REFUSALS.quoteMismatch,
        },
        {
          span: { ...span, pageNumber: 9 },
          code: MATTER_DOCUMENT_ANNOTATION_REFUSALS.pageMissing,
        },
        {
          // The third page has no text layer: there is nothing to mark.
          span: { pageNumber: 3, startOffset: 0, endOffset: 1, quote: "x" },
          code: MATTER_DOCUMENT_ANNOTATION_REFUSALS.pageWithoutText,
        },
      ];
      for (const { code, span: refused } of refusals) {
        expect(
          await create(db, tenant, {
            body: { kind: "comment", body: COMMENT, spans: [refused] },
          }),
        ).toMatchObject({ response: expect.objectContaining({ code }) });
      }
      expect(await storedMarks(db, tenant)).toHaveLength(0);
      expect(await auditEvents(db, tenant)).toHaveLength(0);
    }));

  test("a file the viewer does not show as a PDF, or cannot read, carries no mark", async () =>
    await withTenant(async ({ db, tenant }) => {
      const encrypted = await addVersionFile(db, tenant, {
        content: () => ({ encrypted: true }),
        pages: FIRST_VERSION_PAGES,
        versionNumber: 2,
      });
      const docxWithoutRendition = await addVersionFile(db, tenant, {
        content: () => ({ mimeType: DOCX_MIME_TYPE, pdfFileId: null }),
        pages: FIRST_VERSION_PAGES,
        versionNumber: 3,
      });
      for (const [file, code] of [
        [encrypted, MATTER_DOCUMENT_ANNOTATION_REFUSALS.fileEncrypted],
        [docxWithoutRendition, MATTER_DOCUMENT_ANNOTATION_REFUSALS.fileNotPdf],
      ] as const) {
        expect(
          await create(db, tenant, {
            fieldId: file.fieldId,
            body: {
              kind: "comment",
              body: COMMENT,
              spans: [spanOn(file, 2)],
            },
          }),
        ).toMatchObject({ response: expect.objectContaining({ code }) });
      }
      expect(await storedMarks(db, tenant)).toHaveLength(0);
    }));

  test("a mark is reached only through its own matter and document", async () =>
    await withTenant(async ({ db, tenant }) => {
      const id = createdId(await create(db, tenant));
      // Naming another matter the caller can open finds no such file there.
      expect(
        await list(db, tenant, { workspaceId: tenant.otherWorkspaceId }),
      ).toMatchObject({ code: 404 });
      expect(
        await create(db, tenant, { workspaceId: tenant.otherWorkspaceId }),
      ).toMatchObject({ code: 404 });
      // Another document of the same matter cannot change it by id.
      const otherEntityId = createSafeId<"entity">();
      await db.insert(entities).values({
        id: otherEntityId,
        workspaceId: tenant.workspaceId,
        name: "Order form",
      });
      const update = await updateDocumentAnnotation.handler(
        createTestHandlerContext<
          Parameters<typeof updateDocumentAnnotation.handler>[0]
        >({
          ...contextFor(db, tenant),
          params: {
            workspaceId: tenant.workspaceId,
            entityId: otherEntityId,
            annotationId: id,
          },
          body: { change: "color", color: "red" },
        }),
      );
      expect(update).toMatchObject({ code: 404 });
      // A caller whose matters do not include this one reads nothing, even
      // naming the matter: the row policy holds the mark to the matter.
      const readAs = async (
        visibleWorkspaceIds: SafeId<"workspace">[],
        organizationId = tenant.organizationId,
        userId = tenant.author,
      ) =>
        await createScopedDb(
          markRlsDatabase(db),
          visibleWorkspaceIds,
          organizationId,
          userId,
        )(
          async (tx) =>
            await tx
              .select({ id: legalReaderAnnotations.id })
              .from(legalReaderAnnotations)
              .where(eq(legalReaderAnnotations.entityId, tenant.entityId)),
        );
      expect(await readAs([tenant.workspaceId])).toEqual([{ id }]);
      expect(await readAs([tenant.otherWorkspaceId])).toEqual([]);
      expect(
        await list(db, tenant, {
          visibleWorkspaceIds: [tenant.otherWorkspaceId],
        }),
      ).toMatchObject({ code: 404 });
    }));

  test("another organization neither reads nor writes a document's marks, even naming its matter", async () =>
    await withTenant(async ({ db, tenant }) => {
      const shared = createdId(
        await create(db, tenant, {
          body: {
            kind: "comment",
            body: COMMENT,
            visibility: "shared",
            spans: [spanOn(tenant.first, 2)],
          },
        }),
      );
      const outsider = await seedTenant(db);
      try {
        // The outsider's session holds only their own matters; the request
        // still names the tenant's matter, document, file and mark.
        const asOutsider = {
          organizationId: outsider.organizationId,
          userId: outsider.author,
          visibleWorkspaceIds: [
            outsider.workspaceId,
            outsider.otherWorkspaceId,
          ],
        };
        // Even a session pinned to the tenant's matter reads none of its
        // marks: the row policy holds each mark to its organization.
        expect(
          await createScopedDb(
            markRlsDatabase(db),
            [tenant.workspaceId],
            outsider.organizationId,
            outsider.author,
          )(
            async (tx) =>
              await tx
                .select({ id: legalReaderAnnotations.id })
                .from(legalReaderAnnotations)
                .where(eq(legalReaderAnnotations.id, shared)),
          ),
        ).toEqual([]);
        expect(await list(db, tenant, asOutsider)).toMatchObject({ code: 404 });
        expect(await create(db, tenant, asOutsider)).toMatchObject({
          code: 404,
        });
        const deleted = await deleteDocumentAnnotation.handler(
          createTestHandlerContext<
            Parameters<typeof deleteDocumentAnnotation.handler>[0]
          >({
            ...contextFor(db, tenant, asOutsider),
            params: {
              workspaceId: tenant.workspaceId,
              entityId: tenant.entityId,
              annotationId: shared,
            },
          }),
        );
        expect(deleted).toMatchObject({ code: 404 });
        expect((await storedMarks(db, tenant)).map(({ id }) => id)).toEqual([
          shared,
        ]);
      } finally {
        await db
          .delete(organization)
          .where(eq(organization.id, outsider.organizationId));
        await db.delete(user).where(eq(user.id, outsider.author));
        await db.delete(user).where(eq(user.id, outsider.colleague));
      }
    }));

  test("after a new version the mark is listed with the version and page text it was placed on", async () =>
    await withTenant(async ({ db, tenant }) => {
      const id = createdId(await create(db, tenant));
      const second = await addVersionFile(db, tenant, {
        pages: SECOND_VERSION_PAGES,
        versionNumber: 2,
      });
      // Another file of the same document is a different file, not a version.
      const attachmentProperty = await addProperty(db, tenant.workspaceId);
      const attachment = await addVersionFile(db, tenant, {
        pages: FIRST_VERSION_PAGES,
        propertyId: attachmentProperty,
        versionNumber: 4,
      });

      const [mark, ...rest] = listed(
        await list(db, tenant, { fieldId: second.fieldId }),
      );
      expect(rest).toEqual([]);
      expect(mark).toMatchObject({
        id,
        fieldId: tenant.first.fieldId,
        versionNumber: 1,
        pageNumber: 2,
        quote: QUOTE,
      });
      // The page the second version shows reads differently, so its digest
      // tells the viewer the stored offsets no longer point at the quote.
      const secondPage = second.pageTexts.get(2) ?? panic("No page 2");
      expect(mark?.pageTextSha256).not.toBe(pdfPageTextSha256(secondPage));
      // The first page did not change between versions, and its digest is
      // what a mark on it would carry on either version.
      expect(pdfPageTextSha256(second.pageTexts.get(1) ?? "")).toBe(
        pdfPageTextSha256(tenant.first.pageTexts.get(1) ?? ""),
      );
      expect(
        listed(await list(db, tenant, { fieldId: attachment.fieldId })),
      ).toEqual([]);
    }));

  test("a withdrawn version's marks are hidden with it", async () =>
    await withTenant(async ({ db, tenant }) => {
      createdId(await create(db, tenant));
      const second = await addVersionFile(db, tenant, {
        pages: SECOND_VERSION_PAGES,
        versionNumber: 2,
      });
      await db
        .update(entityVersions)
        .set({ deletedAt: new Date() })
        .where(eq(entityVersions.id, tenant.first.versionId));
      expect(
        listed(await list(db, tenant, { fieldId: second.fieldId })),
      ).toEqual([]);
    }));

  test("deleting the document removes every author's marks on it", async () =>
    await withTenant(async ({ db, tenant }) => {
      createdId(await create(db, tenant));
      createdId(
        await create(db, tenant, {
          userId: tenant.colleague,
          body: {
            kind: "highlight",
            color: "sky",
            style: "highlight",
            spans: [spanOn(tenant.first, 2)],
          },
        }),
      );
      expect(await storedMarks(db, tenant)).toHaveLength(2);
      await db.delete(entities).where(eq(entities.id, tenant.entityId));
      expect(await storedMarks(db, tenant)).toHaveLength(0);
    }));
});
