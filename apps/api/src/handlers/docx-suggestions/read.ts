import { Result } from "better-result";
import { and, asc, eq } from "drizzle-orm";
import { t } from "elysia";

import { docxSuggestions } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { createCursorPage } from "@/api/lib/pagination";

import { docxSuggestionCursor } from "./cursor";
import {
  DOCX_SUGGESTIONS_PAGE_SIZE_DEFAULT,
  DOCX_SUGGESTIONS_PAGE_SIZE_MAX,
} from "./schemas";

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
      cursor: t.Optional(t.String()),
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
      const cursor = docxSuggestionCursor.decode(query.cursor);
      if (cursor === null) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid cursor" }),
        );
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
      })),
    });
  },
);

export default listDocxSuggestions;
