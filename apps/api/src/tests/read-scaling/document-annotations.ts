import { PDF } from "@libpdf/core";
import { panic } from "better-result";
import { eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  entities,
  entityVersions,
  fields,
  properties,
  workspaces,
} from "@/api/db/schema";
import {
  createMembershipSafeDb,
  createScopedDb,
  markRlsDatabase,
} from "@/api/db/scoped";
import { envBase } from "@/api/env-base";
import createDocumentAnnotation from "@/api/handlers/entities/annotations/create";
import deleteDocumentAnnotation from "@/api/handlers/entities/annotations/delete";
import listDocumentAnnotations from "@/api/handlers/entities/annotations/list";
import updateDocumentAnnotation from "@/api/handlers/entities/annotations/update";
import { markedDownloadEndpoint } from "@/api/handlers/files/routes";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { resolveFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import type { FeatureAccessSnapshot } from "@/api/lib/feature-access/policy";
import { readPdfPageTexts } from "@/api/lib/files/pdf-page-text";
import { createFileKey } from "@/api/lib/files/utils";
import { PDF_MIME_TYPE } from "@/api/mime-types";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";

/** The fixed page the list scenario reads, whatever the document holds. */
const PAGE_SIZE = 10;
const PAGE_TEXT = "The seller shall deliver the goods within thirty days.";
const QUOTE = "deliver the goods";

type DocumentAnnotationTenant = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  fieldId: SafeId<"field">;
  span: {
    pageNumber: number;
    startOffset: number;
    endOffset: number;
    quote: string;
  };
  /** The request's feature decisions, resolved once as the auth plugin does. */
  featureAccessSnapshot: FeatureAccessSnapshot;
};

export type DocumentAnnotationScalingFixture = {
  db: GatedTestDb;
  tenant: DocumentAnnotationTenant;
  /** Marks already on the document, oldest first. */
  annotationIds: readonly SafeId<"legalReaderAnnotation">[];
  cleanup: () => Promise<void>;
};

const handlerContext = (db: GatedTestDb, tenant: DocumentAnnotationTenant) => ({
  scopedDb: NO_DB,
  workspaceId: tenant.workspaceId,
  session: { activeOrganizationId: tenant.organizationId },
  user: { id: tenant.userId },
  featureAccessSnapshot: tenant.featureAccessSnapshot,
  safeDb: createMembershipSafeDb(markRlsDatabase(db), {
    organizationId: tenant.organizationId,
    serverValidatedWorkspaceIds: [tenant.workspaceId],
    userId: tenant.userId,
    featureAccessSnapshot: tenant.featureAccessSnapshot,
  }),
  audit: createAuditRecorder({
    organizationId: tenant.organizationId,
    workspaceId: tenant.workspaceId,
    userId: tenant.userId,
    request: new Request("https://example.test/document-annotations"),
    server: null,
  }),
});

const markParams = (
  tenant: DocumentAnnotationTenant,
  annotationId: SafeId<"legalReaderAnnotation">,
) => ({
  workspaceId: tenant.workspaceId,
  entityId: tenant.entityId,
  annotationId,
});

const createMark = async (db: GatedTestDb, tenant: DocumentAnnotationTenant) =>
  await createDocumentAnnotation.handler(
    createTestHandlerContext<
      Parameters<typeof createDocumentAnnotation.handler>[0]
    >({
      ...handlerContext(db, tenant),
      params: {
        workspaceId: tenant.workspaceId,
        entityId: tenant.entityId,
        fieldId: tenant.fieldId,
      },
      body: {
        kind: "highlight",
        color: "yellow",
        style: "highlight",
        spans: [tenant.span],
      },
    }),
  );

const createdId = (result: unknown): SafeId<"legalReaderAnnotation"> => {
  if (
    typeof result !== "object" ||
    result === null ||
    !("id" in result) ||
    typeof result.id !== "string"
  ) {
    return panic("Document mark scaling requires a created mark");
  }
  return toSafeId<"legalReaderAnnotation">(result.id);
};

const requireOk = (result: unknown, scenario: string): void => {
  if (
    typeof result !== "object" ||
    result === null ||
    !("ok" in result) ||
    result.ok !== true
  ) {
    panic(`${scenario} scaling requires a successful handler response`);
  }
};

type SeedDocumentAnnotationScalingOptions = {
  db: GatedTestDb;
  fakeS3: FakeS3;
  size: number;
};

/** One matter with one PDF document and `size` marks on its file. */
export const seedDocumentAnnotationScaling = async ({
  db,
  fakeS3,
  size,
}: SeedDocumentAnnotationScalingOptions): Promise<DocumentAnnotationScalingFixture> => {
  const ids = {
    organizationId: toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`),
    userId: toSafeId<"user">(`usr_${Bun.randomUUIDv7()}`),
    workspaceId: createSafeId<"workspace">(),
    entityId: createSafeId<"entity">(),
    fieldId: createSafeId<"field">(),
  };
  const versionId = createSafeId<"entityVersion">();
  const propertyId = createSafeId<"property">();
  const fileId = Bun.randomUUIDv7();
  const pdf = PDF.create();
  pdf
    .addPage({ size: "letter" })
    .drawText(PAGE_TEXT, { x: 72, y: 700, size: 12 });
  const bytes = await pdf.save();
  fakeS3.put(
    envBase.S3_BUCKET,
    createFileKey({
      organizationId: ids.organizationId,
      workspaceId: ids.workspaceId,
      fileId,
      mimeType: PDF_MIME_TYPE,
    }),
    bytes,
    PDF_MIME_TYPE,
  );
  const pageText =
    (await readPdfPageTexts({ bytes })).at(0)?.text ??
    panic("The scaling PDF has no page");
  const startOffset = pageText.indexOf(QUOTE);
  await db.insert(organization).values({
    id: ids.organizationId,
    name: "Document mark scaling firm",
    slug: ids.organizationId,
    createdAt: new Date(),
  });
  await db.insert(user).values({
    id: ids.userId,
    name: "Reviewer",
    email: `${ids.userId}@example.test`,
    emailVerified: true,
  });
  await db.insert(member).values({
    id: Bun.randomUUIDv7(),
    userId: ids.userId,
    organizationId: ids.organizationId,
    role: "owner",
    createdAt: new Date(),
  });
  await db.insert(workspaces).values({
    id: ids.workspaceId,
    organizationId: ids.organizationId,
    name: "Document mark scaling matter",
    reference: ids.workspaceId,
  });
  await db.insert(entities).values({
    id: ids.entityId,
    workspaceId: ids.workspaceId,
    name: "Purchase agreement",
  });
  await db.insert(entityVersions).values({
    id: versionId,
    entityId: ids.entityId,
    workspaceId: ids.workspaceId,
  });
  await db.insert(properties).values({
    id: propertyId,
    workspaceId: ids.workspaceId,
    name: "File",
    status: "fresh",
    content: { version: 1, type: "file" },
    tool: { version: 1, type: "manual-input" },
  });
  await db.insert(fields).values({
    id: ids.fieldId,
    workspaceId: ids.workspaceId,
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
    },
  });
  const tenant: DocumentAnnotationTenant = {
    ...ids,
    span: {
      pageNumber: 1,
      startOffset,
      endOffset: startOffset + QUOTE.length,
      quote: QUOTE,
    },
    featureAccessSnapshot: await createScopedDb(
      markRlsDatabase(db),
      [ids.workspaceId],
      ids.organizationId,
      ids.userId,
    )(
      async (tx) =>
        await resolveFeatureAccessSnapshot({
          tx,
          organizationId: ids.organizationId,
          userId: ids.userId,
        }),
    ),
  };
  const annotationIds: SafeId<"legalReaderAnnotation">[] = [];
  for (let index = 0; index < size; index += 1) {
    annotationIds.push(createdId(await createMark(db, tenant)));
  }
  return {
    db,
    tenant,
    annotationIds,
    cleanup: async () => {
      await db
        .delete(organization)
        .where(eq(organization.id, tenant.organizationId));
      await db.delete(user).where(eq(user.id, tenant.userId));
    },
  };
};

/**
 * The PDF download that carries the marks: one read of every visible mark
 * and one of the file, however many marks the document holds, with each
 * mark one annotation in the copy.
 */
export const markedPdfDownloadScalingScenario = {
  name: "marked PDF download",
  definition: markedDownloadEndpoint,
  measure: async ({ db, tenant }: DocumentAnnotationScalingFixture) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await markedDownloadEndpoint.handler(
        createTestHandlerContext<
          Parameters<typeof markedDownloadEndpoint.handler>[0]
        >({
          ...handlerContext(db, tenant),
          scopedDb: createScopedDb(
            markRlsDatabase(db),
            [tenant.workspaceId],
            tenant.organizationId,
            tenant.userId,
          ),
          params: { workspaceId: tenant.workspaceId, fieldId: tenant.fieldId },
        }),
      );
      if (!(response instanceof Response) || !response.ok) {
        return panic("Marked PDF download scaling requires the PDF");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const annotations =
        (await PDF.load(bytes)).getPages().at(0)?.getAnnotations() ?? [];
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: bytes.byteLength,
        rows: annotations.length,
      };
    }),
};

const markAt = (
  fixture: DocumentAnnotationScalingFixture,
  index: number,
): SafeId<"legalReaderAnnotation"> =>
  fixture.annotationIds.at(index) ??
  panic("Document mark scaling requires seeded marks");

/**
 * The matter document mark routes, measured on the mounted handlers. The list
 * reads one fixed page; each write touches one mark however many the
 * document holds.
 */
export const documentAnnotationScalingScenarios = [
  {
    name: "document annotation list",
    expectedRows: PAGE_SIZE,
    definition: listDocumentAnnotations,
    measure: async ({ db, tenant }: DocumentAnnotationScalingFixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await listDocumentAnnotations.handler(
          createTestHandlerContext<
            Parameters<typeof listDocumentAnnotations.handler>[0]
          >({
            ...handlerContext(db, tenant),
            params: {
              workspaceId: tenant.workspaceId,
              entityId: tenant.entityId,
              fieldId: tenant.fieldId,
            },
            query: { limit: PAGE_SIZE },
          }),
        );
        if (!("items" in response)) {
          return panic("Document mark list scaling requires a mark page");
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: response.items.length,
        };
      }),
  },
  {
    name: "document annotation create",
    expectedRows: 1,
    definition: createDocumentAnnotation,
    measure: async ({ db, tenant }: DocumentAnnotationScalingFixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await createMark(db, tenant);
        createdId(response);
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: 1,
        };
      }),
  },
  {
    name: "document annotation update",
    expectedRows: 1,
    definition: updateDocumentAnnotation,
    measure: async (fixture: DocumentAnnotationScalingFixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await updateDocumentAnnotation.handler(
          createTestHandlerContext<
            Parameters<typeof updateDocumentAnnotation.handler>[0]
          >({
            ...handlerContext(fixture.db, fixture.tenant),
            params: markParams(fixture.tenant, markAt(fixture, 0)),
            body: { change: "color", color: "green" },
          }),
        );
        requireOk(response, "Document mark update");
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: 1,
        };
      }),
  },
  {
    name: "document annotation delete",
    expectedRows: 1,
    definition: deleteDocumentAnnotation,
    measure: async (fixture: DocumentAnnotationScalingFixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await deleteDocumentAnnotation.handler(
          createTestHandlerContext<
            Parameters<typeof deleteDocumentAnnotation.handler>[0]
          >({
            ...handlerContext(fixture.db, fixture.tenant),
            params: markParams(fixture.tenant, markAt(fixture, -1)),
          }),
        );
        requireOk(response, "Document mark delete");
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: 1,
        };
      }),
  },
];
