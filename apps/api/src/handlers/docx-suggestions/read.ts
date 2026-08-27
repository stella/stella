import { Result } from "better-result";
import { and, asc, eq } from "drizzle-orm";
import { t } from "elysia";

import { DOCX_SUGGESTIONS_PAGE_SIZE_MAX } from "@stll/api-contract";

import { docxSuggestions } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import {
  tPaginationCursor,
  tSafeId,
  workspaceParams,
} from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { createCursorPage } from "@/api/lib/pagination";

import { docxSuggestionCursor } from "./cursor";
import { DOCX_SUGGESTIONS_PAGE_SIZE_DEFAULT } from "./schemas";

/**
 * Where a suggestion came from, as the reader groups it: a document review
 * stages each finding's fix as a suggestion of its own, everything else was
 * proposed in the chat over the document. Named rather than shipping the
 * finding id, because a client listing suggestions has no run to resolve one
 * against; named rather than a flag, because a third producer would need a
 * name here rather than a second boolean.
 *
 * The response type is what the web client's own origin union is checked
 * against, so the two cannot drift apart without failing that build.
 */
const DOCX_SUGGESTION_ORIGIN = {
  chat: "chat",
  review: "review",
} as const;

type DocxSuggestionOrigin =
  (typeof DOCX_SUGGESTION_ORIGIN)[keyof typeof DOCX_SUGGESTION_ORIGIN];

// Annotated: an inline ternary in the projection literal would widen to
// `string`, and the client would lose the union.
const suggestionOrigin = (
  originReviewFindingId: string | null,
): DocxSuggestionOrigin =>
  originReviewFindingId === null
    ? DOCX_SUGGESTION_ORIGIN.chat
    : DOCX_SUGGESTION_ORIGIN.review;

/**
 * List an entity's persisted suggestions (pending and resolved), oldest
 * first, cursor-paginated. `entity read` permission (workspace-level read
 * grant). The client re-derives block id / summary / inline preview from
 * `opPayload` against the live document on hydration, so the projection is
 * minimal.
 */
const listDocxSuggestions = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    mcp: { type: "internal", reason: "document_processing" },
    params: workspaceParams({ entityId: tSafeId("entity") }),
    query: t.Object({
      cursor: t.Optional(tPaginationCursor()),
      limit: t.Optional(
        t.Integer({ minimum: 1, maximum: DOCX_SUGGESTIONS_PAGE_SIZE_MAX }),
      ),
      status: t.Optional(
        t.Union([
          t.Literal("pending"),
          t.Literal("accepted"),
          t.Literal("rejected"),
        ]),
      ),
    }),
  },
  async function* ({ workspaceId, params, query, safeDb }) {
    const limit = query.limit ?? DOCX_SUGGESTIONS_PAGE_SIZE_DEFAULT;

    const conditions = [
      eq(docxSuggestions.workspaceId, workspaceId),
      eq(docxSuggestions.entityId, params.entityId),
    ];
    if (query.status !== undefined) {
      conditions.push(eq(docxSuggestions.status, query.status));
    }
    if (query.cursor !== undefined) {
      const decodedCursor = docxSuggestionCursor.decode(query.cursor);
      if (decodedCursor === null) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid cursor" }),
        );
      }
      let cursor = decodedCursor;
      if (cursor.timestamp.precision === "milliseconds") {
        // The legacy timestamp cannot order rows inside its millisecond. Its
        // id can: resolve that row's exact timestamp without leaving the DB's
        // precision, scoped to the same entity and workspace as the list.
        const [boundary] = yield* Result.await(
          safeDb((tx) =>
            tx
              .select({
                createdAtCursor:
                  docxSuggestionCursor.cursorValue.as("created_at_cursor"),
              })
              .from(docxSuggestions)
              .where(
                and(
                  eq(docxSuggestions.workspaceId, workspaceId),
                  eq(docxSuggestions.entityId, params.entityId),
                  eq(docxSuggestions.id, cursor.id),
                ),
              )
              .limit(1),
          ),
        );
        if (boundary === undefined) {
          return Result.ok({ items: [], limit, nextCursor: null });
        }
        const exactCursor = docxSuggestionCursor.decode(
          docxSuggestionCursor.encode(boundary.createdAtCursor, cursor.id),
        );
        if (exactCursor === null) {
          return Result.err(
            new HandlerError({
              status: 500,
              message: "Could not resolve suggestion cursor boundary",
            }),
          );
        }
        cursor = exactCursor;
      }
      const keyset = docxSuggestionCursor.keysetAfter({
        cursor,
        idColumn: docxSuggestions.id,
        direction: "ascending",
      });
      if (keyset !== undefined) {
        conditions.push(keyset);
      }
    }

    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: docxSuggestions.id,
            opPayload: docxSuggestions.opPayload,
            comment: docxSuggestions.comment,
            severity: docxSuggestions.severity,
            area: docxSuggestions.area,
            status: docxSuggestions.status,
            appliedMode: docxSuggestions.appliedMode,
            createdAt: docxSuggestions.createdAt,
            originReviewFindingId: docxSuggestions.originReviewFindingId,
            createdAtCursor:
              docxSuggestionCursor.cursorValue.as("created_at_cursor"),
          })
          .from(docxSuggestions)
          .where(and(...conditions))
          .orderBy(asc(docxSuggestions.createdAt), asc(docxSuggestions.id))
          .limit(limit + 1),
      ),
    );

    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: (item) =>
        docxSuggestionCursor.encode(item.createdAtCursor, item.id),
    });

    // `createdAtCursor` is the serialization projection, not part of the
    // response contract; drop it after the page is cut.
    return Result.ok({
      ...page,
      items: page.items.map((item) => ({
        id: item.id,
        opPayload: item.opPayload,
        comment: item.comment,
        severity: item.severity,
        area: item.area,
        status: item.status,
        appliedMode: item.appliedMode,
        createdAt: item.createdAt,
        origin: suggestionOrigin(item.originReviewFindingId),
      })),
    });
  },
);

export default listDocxSuggestions;
