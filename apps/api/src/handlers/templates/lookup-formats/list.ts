import { Result } from "better-result";
import { and, desc, eq, getTableColumns, isNotNull, lt, or } from "drizzle-orm";
import { t } from "elysia";

import {
  LOOKUP_FORMAT_PREFERENCE,
  templateLookupFormatUserDefaults,
  templateLookupFormats,
} from "@/api/db/schema";
import {
  FORMAT_LIMITS,
  toResponse,
} from "@/api/handlers/templates/lookup-formats/projection";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tPaginationCursor } from "@/api/lib/custom-schema";
import { LOOKUP_REGISTRIES } from "@/api/lib/docx/types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedTemplateLookupFormatId } from "@/api/lib/safe-id-boundaries";

const config = {
  description:
    "List shared company specification formats and the default for a business registry in the active organization.",
  permissions: { workspace: ["read"] },
  access: "read",
  mcp: { type: "capability", reason: "template_authoring_ui" },
  query: t.Object({
    registry: t.UnionEnum(LOOKUP_REGISTRIES),
    limit: t.Optional(
      t.Integer({ minimum: 1, maximum: FORMAT_LIMITS.pageMax }),
    ),
    cursor: t.Optional(tPaginationCursor()),
  }),
} satisfies HandlerConfig;

const listLookupFormats = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, query }) {
    const limit = query.limit ?? FORMAT_LIMITS.pageDefault;
    const conditions = [
      eq(templateLookupFormats.organizationId, session.activeOrganizationId),
      eq(templateLookupFormats.registry, query.registry),
    ];
    if (query.cursor) {
      const parts = decodePaginationCursor(query.cursor);
      const id = parts?.at(0);
      if (
        parts?.length !== 2 ||
        !isUuidPaginationCursorPart(id) ||
        parts.at(1) !== query.registry
      ) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid cursor" }),
        );
      }
      conditions.push(
        lt(templateLookupFormats.id, brandPersistedTemplateLookupFormatId(id)),
      );
    }
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select()
          .from(templateLookupFormats)
          .where(and(...conditions))
          // IDs are server-minted UUIDv7: immutable newest-first pagination.
          .orderBy(desc(templateLookupFormats.id))
          .limit(limit + 1),
      ),
    );
    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: (row) => encodePaginationCursor([row.id, row.registry]),
    });
    // Both defaults in one statement: the organization's, which every colleague
    // sees, and the caller's own override of it. They are returned apart rather
    // than pre-resolved because the client labels the two rows differently; the
    // member who picked the organization's own default is one row answering to
    // both. Bounded at two: only one of each can exist.
    const defaultRows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            ...getTableColumns(templateLookupFormats),
            // Non-null exactly on the row the caller chose for themselves.
            chosenBy: templateLookupFormatUserDefaults.userId,
          })
          .from(templateLookupFormats)
          .leftJoin(
            templateLookupFormatUserDefaults,
            and(
              eq(
                templateLookupFormatUserDefaults.formatId,
                templateLookupFormats.id,
              ),
              eq(templateLookupFormatUserDefaults.userId, user.id),
              eq(
                templateLookupFormatUserDefaults.organizationId,
                session.activeOrganizationId,
              ),
              eq(templateLookupFormatUserDefaults.registry, query.registry),
            ),
          )
          .where(
            and(
              eq(
                templateLookupFormats.organizationId,
                session.activeOrganizationId,
              ),
              eq(templateLookupFormats.registry, query.registry),
              or(
                isNotNull(templateLookupFormatUserDefaults.userId),
                eq(
                  templateLookupFormats.preference,
                  LOOKUP_FORMAT_PREFERENCE.DEFAULT,
                ),
              ),
            ),
          )
          .limit(2),
      ),
    );
    const defaultFormat = defaultRows.find(
      (row) => row.preference === LOOKUP_FORMAT_PREFERENCE.DEFAULT,
    );
    const userDefaultFormat = defaultRows.find((row) => row.chosenBy !== null);
    return Result.ok({
      ...page,
      items: page.items.map(toResponse),
      defaultFormat: defaultFormat ? toResponse(defaultFormat) : null,
      userDefaultFormat: userDefaultFormat
        ? toResponse(userDefaultFormat)
        : null,
    });
  },
);

export default listLookupFormats;
