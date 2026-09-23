import { Result } from "better-result";
import { and, asc, eq, sql } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import { member, user } from "@/api/db/auth-schema";
import { legalReaderAnnotations } from "@/api/db/schema";
import {
  annotationTargetTypeSchema,
  requireAnnotationTargetType,
} from "@/api/handlers/legal-reader/annotations/schema";
import type { AnnotationAuthorScope } from "@/api/handlers/legal-reader/annotations/target";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import {
  tPaginationCursor,
  tPaginationLimit,
  tUuid,
} from "@/api/lib/custom-schema";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";
import { brandPersistedLegalReaderAnnotationId } from "@/api/lib/safe-id-boundaries";

const querySchema = t.Object({
  targetType: annotationTargetTypeSchema,
  targetId: tUuid,
  cursor: t.Optional(tPaginationCursor()),
  limit: t.Optional(tPaginationLimit(LIMITS.readerAnnotationsPageSizeMax)),
});

const config = {
  permissions: { workspace: ["read"] },
  description:
    "List the highlights and comments on one decision or statute version: the caller's own and those colleagues shared.",
  mcp: { type: "tool", name: "list_reader_annotations" },
  access: "read",
  query: querySchema,
} satisfies HandlerConfig;

const annotationCursor = createTimestampIdCursorCodec({
  column: legalReaderAnnotations.createdAt,
  brandId: brandPersistedLegalReaderAnnotationId,
});

/**
 * The columns of the mark itself that the reader receives. The author's name
 * and picture come from the membership join and the cursor from the codec, so
 * they are added at the query; this is the table's own share, and the guards
 * below are what force a new column on the table to be decided about.
 */
const ANNOTATION_PROJECTION = {
  id: legalReaderAnnotations.id,
  groupId: legalReaderAnnotations.groupId,
  kind: legalReaderAnnotations.kind,
  visibility: legalReaderAnnotations.visibility,
  color: legalReaderAnnotations.color,
  style: legalReaderAnnotations.style,
  blockAnchorId: legalReaderAnnotations.blockAnchorId,
  startOffset: legalReaderAnnotations.startOffset,
  endOffset: legalReaderAnnotations.endOffset,
  quote: legalReaderAnnotations.quote,
  body: legalReaderAnnotations.body,
  createdAt: legalReaderAnnotations.createdAt,
  updatedAt: legalReaderAnnotations.updatedAt,
} as const;

type AnnotationRow = typeof legalReaderAnnotations.$inferSelect;

const UNPROJECTED_ANNOTATION_COLUMNS = [
  // The caller's own organization: the predicate and the row policy both
  // pin it, so the reader learns nothing from it coming back.
  "organizationId",
  // Sent as `authorId`, beside the name the membership join resolves.
  "userId",
  // The document the caller named in the query; echoing it repeats the ask.
  "targetId",
  "targetType",
] as const satisfies readonly (keyof AnnotationRow)[];

type MissingProjectedAnnotationColumn = UnprojectedColumns<
  AnnotationRow,
  typeof ANNOTATION_PROJECTION,
  (typeof UNPROJECTED_ANNOTATION_COLUMNS)[number]
>;
type UnexpectedProjectedAnnotationColumn = UnbackedProjectionKeys<
  AnnotationRow,
  typeof ANNOTATION_PROJECTION,
  (typeof UNPROJECTED_ANNOTATION_COLUMNS)[number]
>;

true satisfies MissingProjectedAnnotationColumn extends never ? true : never;
true satisfies UnexpectedProjectedAnnotationColumn extends never ? true : never;

/**
 * Every annotation on one document the caller may see: their own, and what
 * colleagues shared. Row-level security draws that line; the query only
 * names the document. The author is read through the organization's
 * membership, so a name is only ever shown for a colleague. Oldest first,
 * so the margin reads in the order the notes were made.
 */
type ListReaderAnnotationsProps = Omit<
  AnnotationAuthorScope,
  "recordAuditEvent"
> & {
  query: Static<typeof querySchema>;
};

export const listReaderAnnotationsHandler = async function* ({
  organizationId,
  query,
  safeDb,
  userId,
}: ListReaderAnnotationsProps) {
  const limit = query.limit ?? LIMITS.readerAnnotationsPageSizeDefault;
  const conditions = [
    eq(legalReaderAnnotations.organizationId, organizationId),
    eq(
      legalReaderAnnotations.targetType,
      requireAnnotationTargetType(query.targetType),
    ),
    eq(legalReaderAnnotations.targetId, query.targetId),
  ];

  if (query.cursor) {
    const cursor = annotationCursor.decode(query.cursor);
    if (!cursor) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }
    const cursorCondition = annotationCursor.keysetAfter({
      cursor,
      direction: "ascending",
      idColumn: legalReaderAnnotations.id,
    });
    if (cursorCondition) {
      conditions.push(cursorCondition);
    }
  }

  const rows = yield* Result.await(
    safeDb((tx) =>
      tx
        .select({
          ...ANNOTATION_PROJECTION,
          authorId: legalReaderAnnotations.userId,
          authorName: user.name,
          authorImage: user.image,
          mine: sql<boolean>`${legalReaderAnnotations.userId} = ${userId}`,
          createdAtCursor: annotationCursor.cursorValue.as("created_at_cursor"),
        })
        .from(legalReaderAnnotations)
        .innerJoin(
          member,
          and(
            eq(member.userId, legalReaderAnnotations.userId),
            eq(member.organizationId, organizationId),
          ),
        )
        .innerJoin(user, eq(user.id, member.userId))
        .where(and(...conditions))
        .orderBy(
          asc(legalReaderAnnotations.createdAt),
          asc(legalReaderAnnotations.id),
        )
        .limit(limit + 1),
    ),
  );

  const page = createCursorPage({
    rows,
    limit,
    cursorForItem: (item) =>
      annotationCursor.encode(item.createdAtCursor, item.id),
  });

  return Result.ok({
    ...page,
    items: page.items.map(({ createdAtCursor: _, ...item }) => item),
  });
};

const listReaderAnnotations = createSafeRootHandler(
  config,
  async function* ({ query, safeDb, session, user: me }) {
    return yield* listReaderAnnotationsHandler({
      organizationId: session.activeOrganizationId,
      query,
      safeDb,
      userId: me.id,
    });
  },
);

export default listReaderAnnotations;
