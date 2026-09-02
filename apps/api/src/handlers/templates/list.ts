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
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";
import { brandPersistedTemplateId } from "@/api/lib/safe-id-boundaries";

type TemplateRow = typeof templates.$inferSelect;

// Columns intentionally not sent by this page. A new schema column must
// either be added to the `.select()` below or added here with a reason, or
// the totality check further down fails to typecheck.
const UNPROJECTED_TEMPLATE_LIST_COLUMNS = [
  // Tenant scope, implied by the caller's active organization.
  "organizationId",
  // Document vs report discriminator: as of 2026-09-02 nothing filters or
  // surfaces `kind` on this list (or on templates.get), so a "report" kind
  // template is indistinguishable from a "document" one here. Flagged as a
  // real gap for review rather than fixed inline.
  "kind",
  // Internal object storage location; never sent to the client.
  "s3Key",
  // Large structural manifest, parsed at get-time only; omitted from the
  // list view for payload size.
  "manifest",
  // Internal write-side counter for optimistic content-rotation locking.
  // The client sees version numbers via templates.versions, not this row.
  "currentVersion",
  // Full provenance detail (pack attribution) belongs to the get view;
  // the list view only ranks/filters by category.
  "originType",
  "origin",
  // Resolved to authorName/authorImage via the member/user join below;
  // the raw id is not needed client-side.
  "createdBy",
] as const satisfies readonly (keyof TemplateRow)[];

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

// The shape the `.select({...})` below must project, plus the two
// author-identity fields that come from the joined `user` row rather than
// from `templates` itself.
type TemplateListItem = Pick<
  TemplateRow,
  | "id"
  | "name"
  | "fileName"
  | "fieldCount"
  | "sizeBytes"
  | "categoryId"
  | "createdAt"
  | "updatedAt"
  | "lastUsedAt"
  | "useCount"
  | "tags"
  | "languages"
  | "whenToUse"
  | "whenNotToUse"
> & { authorName: string | null; authorImage: string | null };

// Totality guard, bidirectional: every schema column must be projected onto
// the response or explicitly excused above, and the projection cannot carry
// a field that traces back to no real column, aside from the joined
// authorName/authorImage.
type MissingProjectedTemplateListColumn = UnprojectedColumns<
  TemplateRow,
  TemplateListItem,
  (typeof UNPROJECTED_TEMPLATE_LIST_COLUMNS)[number]
>;
type UnexpectedProjectedTemplateListColumn = UnbackedProjectionKeys<
  TemplateRow,
  Omit<TemplateListItem, "authorName" | "authorImage">
>;

true satisfies MissingProjectedTemplateListColumn extends never ? true : never;
true satisfies UnexpectedProjectedTemplateListColumn extends never
  ? true
  : never;

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

  // Ties the `.select({...})` above to `TemplateListItem`: if either drops
  // a field the other still names, this check stops typechecking.
  const projectedResult = result satisfies TemplateListItem[];

  const page = createCursorPage({
    rows: projectedResult,
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
  description:
    "List the document templates in this organization (NDAs, powers of " +
    "attorney, leases): each template's id, name, field count, tags, and " +
    "usage guidance (whenToUse / whenNotToUse); prefer a template whose " +
    "whenToUse matches the request and skip any whose whenNotToUse applies.",
  permissions: { workspace: ["read"] },
  mcp: { type: "tool", name: "list_templates" },
  access: "read",
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
