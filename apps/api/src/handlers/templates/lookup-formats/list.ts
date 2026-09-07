import { Result } from "better-result";
import { and, desc, eq, lt } from "drizzle-orm";
import { t } from "elysia";

import {
  LOOKUP_FORMAT_PREFERENCE,
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
  async function* ({ safeDb, session, query }) {
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
    const defaults = yield* Result.await(
      safeDb((tx) =>
        tx
          .select()
          .from(templateLookupFormats)
          .where(
            and(
              eq(
                templateLookupFormats.organizationId,
                session.activeOrganizationId,
              ),
              eq(templateLookupFormats.registry, query.registry),
              eq(
                templateLookupFormats.preference,
                LOOKUP_FORMAT_PREFERENCE.DEFAULT,
              ),
            ),
          )
          .limit(1),
      ),
    );
    const defaultFormat = defaults.at(0);
    return Result.ok({
      ...page,
      items: page.items.map(toResponse),
      defaultFormat: defaultFormat ? toResponse(defaultFormat) : null,
    });
  },
);

export default listLookupFormats;
