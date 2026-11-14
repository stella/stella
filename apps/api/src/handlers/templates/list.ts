import { Result } from "better-result";
import { and, desc, eq, isNull } from "drizzle-orm";
import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";

import { member, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { templates } from "@/api/db/schema";
import {
  decodeTemplateListCursor,
  encodeTemplateListCursor,
  templateCursorCreatedAt,
  templateListCursorCondition,
} from "@/api/handlers/templates/list-cursor";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import {
  paginationCursorSchema,
  resourceIdSchema,
} from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";

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
  // Whether the stored file has passed the scan; read only by the server's
  // own file reader.
  "scanState",
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

const listTemplatesQuerySchema = v.object({
  categoryId: v.exactOptional(
    v.union([resourceIdSchema("templateCategory"), v.literal(UNCATEGORIZED)]),
  ),
  cursor: v.exactOptional(paginationCursorSchema()),
  limit: v.exactOptional(
    numberFromString(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(LIMITS.templatesPageSizeMax),
      ),
    ),
  ),
});

// The exact `.select({...})` passed to the query below. Hoisted so the
// selection and the derived `TemplateListItem` type can never drift apart.
const TEMPLATE_LIST_SELECTION = {
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
} as const;

// Select + from + join only: the row shape this produces is unaffected by
// the `.where()`/`.orderBy()`/`.limit()` the real query below chains onto
// it, so this alone is enough to derive `TemplateListItem` from. Both joins
// are left joins, so `authorName`/`authorImage` come out nullable -- a
// departed or otherwise unresolved author renders as anonymous rather than
// failing the query.
const selectTemplateListRows = ({
  tx,
  organizationId,
}: {
  tx: Transaction;
  organizationId: SafeId<"organization">;
}) =>
  tx
    .select({
      ...TEMPLATE_LIST_SELECTION,
      cursorCreatedAt: templateCursorCreatedAt,
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
    .leftJoin(user, eq(user.id, member.userId));

// The two author-identity fields come from the joined `user` row rather than
// from `templates` itself, so they stay excluded from the reverse totality
// check via `Omit`.
type TemplateListItem = Omit<
  Awaited<ReturnType<typeof selectTemplateListRows>>[number],
  "cursorCreatedAt"
>;

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
  Omit<TemplateListItem, "authorName" | "authorImage">,
  (typeof UNPROJECTED_TEMPLATE_LIST_COLUMNS)[number]
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
  const limit = normalizeTenantPageLimit(
    query.limit ?? LIMITS.templatesPageSizeDefault,
  );
  const conditions = [eq(templates.organizationId, organizationId)];

  if (query.categoryId === UNCATEGORIZED) {
    conditions.push(isNull(templates.categoryId));
  } else if (query.categoryId) {
    conditions.push(eq(templates.categoryId, query.categoryId));
  }

  if (query.cursor) {
    const boundary = decodeTemplateListCursor(query.cursor);
    if (boundary === null) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }
    conditions.push(templateListCursorCondition(boundary));
  }

  const result = yield* Result.await(
    safeDb((tx) =>
      selectTemplateListRows({ tx, organizationId })
        .where(and(...conditions))
        .orderBy(desc(templates.createdAt), desc(templates.id))
        .limit(limit + 1),
    ),
  );

  const page = createCursorPage({
    rows: result,
    limit,
    cursorForItem: encodeTemplateListCursor,
  });

  return Result.ok({
    ...page,
    items: page.items.map(({ cursorCreatedAt, ...item }) => item),
    // Per-org create cap (LIMITS.templatesCount), surfaced so the UI can
    // warn before hitting it; unrelated to this page's `limit`.
    templatesCountLimit: LIMITS.templatesCount,
  });
};

const config = {
  contract: "patch",
  description:
    "List the document templates in this organization (NDAs, powers of " +
    "attorney, leases): each template's id, name, field count, tags, and " +
    "usage guidance (whenToUse / whenNotToUse); prefer a template whose " +
    "whenToUse matches the request and skip any whose whenNotToUse applies.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
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
