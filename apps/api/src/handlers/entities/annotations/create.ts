/**
 * Highlight or comment on a passage of a matter document's PDF, as the user.
 * The passage is placed on the file the reader had open: its words are
 * checked against the text of each page they sit on, and the page text's
 * digest is kept so a later version shows the mark as detached.
 */

import { Result } from "better-result";
import * as v from "valibot";

import {
  READER_ANNOTATION_MAX_SPANS,
  READER_ANNOTATION_QUOTE_MAX_LENGTH,
  READER_PDF_PAGE_NUMBER_MAX,
} from "@stll/api-contract/legal-reader-annotations";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { createReaderAnnotationHandler } from "@/api/lib/legal-search/reader-annotations/create";
import {
  documentFileNotFound,
  placeMatterDocumentSpans,
  readMarkedDocumentField,
} from "@/api/lib/legal-search/reader-annotations/matter-document";
import {
  annotationColorSchema,
  annotationCommentTextSchema,
  annotationStyleSchema,
  annotationVisibilitySchema,
} from "@/api/lib/legal-search/reader-annotations/schema";
import type { CreateAnnotationRequest } from "@/api/lib/legal-search/reader-annotations/schema";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";

/** One page's share of the passage: UTF-16 offsets into its extracted text. */
const documentSpanSchema = v.pipe(
  v.strictObject({
    pageNumber: v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1),
      v.maxValue(READER_PDF_PAGE_NUMBER_MAX),
    ),
    startOffset: v.pipe(v.number(), v.integer(), v.minValue(0)),
    endOffset: v.pipe(v.number(), v.integer(), v.minValue(1)),
    quote: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(READER_ANNOTATION_QUOTE_MAX_LENGTH),
    ),
  }),
  v.check(
    ({ endOffset, startOffset }) => endOffset > startOffset,
    "A span must cover at least one character",
  ),
);

const spansSchema = v.pipe(
  v.array(documentSpanSchema),
  v.minLength(1),
  v.maxLength(READER_ANNOTATION_MAX_SPANS),
);

const sharedFields = {
  requestId: v.optional(resourceIdSchema("legalReaderAnnotation")),
  visibility: v.optional(annotationVisibilitySchema),
  spans: spansSchema,
} as const;

/** One body per kind, so a highlight cannot carry words and a comment cannot
 *  arrive without them. */
const bodySchema = v.union([
  v.strictObject({
    ...sharedFields,
    kind: v.literal("highlight"),
    color: annotationColorSchema,
    style: annotationStyleSchema,
  }),
  v.strictObject({
    ...sharedFields,
    kind: v.literal("comment"),
    body: annotationCommentTextSchema,
  }),
]);

const config = {
  contract: "patch",
  contentDelivery: {
    type: "none",
    reason:
      "Reads the file's extracted text to check quotes; returns the mark.",
  },
  realtime: noResourceSetUpdates(
    "Document marks refresh through the document's own mark query; no listed resource set changes",
  ),
  description:
    "Highlight or comment on a passage of a matter document's PDF, as the " +
    "user. Each span names a page of the file and offsets into that page's " +
    "extracted text, and `quote` must be exactly those words. Private unless " +
    "visibility is shared, which shows it to everyone who can open the " +
    "matter. Resending the same requestId returns the mark it already made.",
  permissions: { legalReaderAnnotation: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "document_processing" },
  params: workspaceParams({
    entityId: resourceIdSchema("entity"),
    fieldId: resourceIdSchema("field"),
  }),
  body: bodySchema,
} satisfies WorkspaceHandlerConfig;

const createDocumentAnnotation = createSafeHandler(
  config,
  async function* ({
    body,
    params: { entityId, fieldId },
    recordAuditEvent,
    safeDb,
    session,
    user,
    workspaceId,
  }) {
    const organizationId = session.activeOrganizationId;
    const field = yield* Result.await(
      safeDb(async (tx) => {
        // Holds the matter while its file is read, as a claim comment does.
        await withAggregateLock({
          aggregate: "workspace",
          id: { id: workspaceId, organizationId },
          mode: "key share",
          tx,
        });
        return await readMarkedDocumentField({
          entityId,
          fieldId,
          tx,
          workspaceId,
        });
      }),
    );
    if (field === undefined) {
      return Result.err(documentFileNotFound());
    }
    const placed = yield* Result.await(
      placeMatterDocumentSpans({
        field,
        organizationId,
        spans: body.spans,
        workspaceId,
      }),
    );
    const shared = {
      spans: placed.spans,
      targetId: fieldId,
      targetType: "matter-document",
      ...(body.visibility === undefined ? {} : { visibility: body.visibility }),
      ...(body.requestId === undefined ? {} : { requestId: body.requestId }),
    } as const;
    const request: CreateAnnotationRequest =
      body.kind === "highlight"
        ? { ...shared, kind: "highlight", color: body.color, style: body.style }
        : { ...shared, kind: "comment", body: body.body };
    return yield* createReaderAnnotationHandler({
      body: request,
      organizationId,
      placement: {
        type: "matter-document",
        entityId,
        fieldId,
        workspaceId,
        pageTextSha256ByAnchorId: placed.pageTextSha256ByAnchorId,
      },
      recordAuditEvent,
      replayIdentity: "spans",
      safeDb,
      userId: user.id,
    });
  },
);

declareAggregateMutation(createDocumentAnnotation, {
  type: "aggregate",
  aggregates: ["workspace"],
});

export default createDocumentAnnotation;
