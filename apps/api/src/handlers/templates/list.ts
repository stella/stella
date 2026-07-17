import { Result } from "better-result";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { t } from "elysia";

import { member, user } from "@/api/db/auth-schema";
import type { SafeDb } from "@/api/db/safe-db";
import { templates } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedTemplateId } from "@/api/lib/safe-id-boundaries";

const UNCATEGORIZED = "uncategorized" as const;

const listTemplatesQuerySchema = t.Object({
  categoryId: t.Optional(
    t.Union([tSafeId("templateCategory"), t.Literal(UNCATEGORIZED)]),
  ),
  cursor: t.Optional(t.String({ maxLength: 512 })),
  limit: t.Optional(
    t.Integer({ minimum: 1, maximum: LIMITS.templatesPageSizeMax }),
  ),
});

// The cursor is the boundary template id alone; the query resolves its
// (createdAt, id) tuple in-DB so it never round-trips a timestamp through a
// millisecond-precision JS Date.
export const decodeTemplateListCursor = (
  cursor: string,
): SafeId<"template"> | null => {
  const parts = decodePaginationCursor(cursor);
  const id = parts?.at(0);
  return isUuidPaginationCursorPart(id) ? brandPersistedTemplateId(id) : null;
};

export const encodeTemplateListCursor = (id: SafeId<"template">): string =>
  encodePaginationCursor([id]);

type ListTemplatesProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  query: {
    categoryId?: SafeId<"templateCategory"> | typeof UNCATEGORIZED;
    cursor?: string;
    limit?: number;
  };
};

export const listTemplatesHandler = async function* ({
  safeDb,
  organizationId,
  query,
}: ListTemplatesProps) {
  const limit = query.limit ?? LIMITS.templatesPageSizeDefault;
  const conditions = [eq(templates.organizationId, organizationId)];

  if (query.categoryId === UNCATEGORIZED) {
    conditions.push(isNull(templates.categoryId));
  } else if (query.categoryId) {
    conditions.push(eq(templates.categoryId, query.categoryId));
  }

  if (query.cursor) {
    const boundaryId = decodeTemplateListCursor(query.cursor);
    if (boundaryId === null) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }
    // Resolve the full-precision (createdAt, id) boundary in-DB by id so the
    // cursor never round-trips createdAt through a millisecond JS Date. The
    // boundary lookup is org-scoped (defense in depth beyond RLS) so a
    // cursor carrying a foreign template id cannot shift this org's page
    // boundary. Mirrors the list_templates MCP tool's keyset condition.
    conditions.push(
      sql`(${templates.createdAt}, ${templates.id}) < (select b.created_at, b.id from templates b where b.id = ${boundaryId} and b.organization_id = ${organizationId})`,
    );
  }

  const result = yield* Result.await(
    safeDb((tx) =>
      tx
        .select({
          id: templates.id,
          name: templates.name,
          fileName: templates.fileName,
          fieldCount: templates.fieldCount,
          sizeBytes: templates.sizeBytes,
          categoryId: templates.categoryId,
          createdAt: templates.createdAt,
          updatedAt: templates.updatedAt,
          lastUsedAt: templates.lastUsedAt,
          useCount: templates.useCount,
          tags: templates.tags,
          languages: templates.languages,
          whenToUse: templates.whenToUse,
          whenNotToUse: templates.whenNotToUse,
          authorName: user.name,
          authorImage: user.image,
        })
        .from(templates)
        // Author identity only for users still in the org: scope the
        // user join through membership so departed users render as
        // anonymous instead of leaking profile data.
        .leftJoin(
          member,
          and(
            eq(member.userId, templates.createdBy),
            eq(member.organizationId, organizationId),
          ),
        )
        .leftJoin(user, eq(user.id, member.userId))
        .where(and(...conditions))
        .orderBy(desc(templates.createdAt), desc(templates.id))
        .limit(limit + 1),
    ),
  );

  const page = createCursorPage({
    rows: result,
    limit,
    cursorForItem: (item) => encodeTemplateListCursor(item.id),
  });

  return Result.ok({
    ...page,
    // Per-org create cap (LIMITS.templatesCount), surfaced so the UI can
    // warn before hitting it; unrelated to this page's `limit`.
    templatesCountLimit: LIMITS.templatesCount,
  });
};

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "tool", name: "list_templates" },
  query: listTemplatesQuerySchema,
} satisfies HandlerConfig;

const listTemplates = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, query }) {
    return yield* listTemplatesHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      query,
    });
  },
);

export default listTemplates;
