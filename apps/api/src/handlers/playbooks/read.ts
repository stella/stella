import { Result } from "better-result";
import { and, desc, eq, sql } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import { playbookDefinitions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
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
import { brandPersistedPlaybookDefinitionId } from "@/api/lib/safe-id-boundaries";

type PlaybookDefinitionRow = typeof playbookDefinitions.$inferSelect;

// ── List ────────────────────────────────────────────

// Columns intentionally not sent by the list summary. A new schema column
// must either be projected by `toPlaybookDefinitionListItem` below or added
// here with a reason, or the totality check further down fails to
// typecheck.
const UNPROJECTED_PLAYBOOK_LIST_COLUMNS = [
  // Tenant scope, implied by the caller's active organization.
  "organizationId",
  // Server-only bundled-starter correlation id; never read back (see the
  // `starterId` doc comment on the schema column).
  "starterId",
  // unprojected as of 2026-09-02; review — the config description below
  // claims this list carries "scope ... and approval metadata", but neither
  // `scope`/`positions` nor `approvedAt`/`approvedBy` are actually selected
  // or mapped here. Full detail is available via playbooks.get; flagging
  // rather than silently adding fields that may not belong on the summary.
  "scope",
  "positions",
  "approvedAt",
  "approvedBy",
] as const satisfies readonly (keyof PlaybookDefinitionRow)[];

// The shape the list `.select({...})` below must project.
type PlaybookDefinitionListRow = Pick<
  PlaybookDefinitionRow,
  "id" | "name" | "description" | "status" | "createdAt" | "updatedAt"
>;

const toPlaybookDefinitionListItem = (row: PlaybookDefinitionListRow) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  status: row.status,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

type PlaybookDefinitionListItem = ReturnType<
  typeof toPlaybookDefinitionListItem
>;

// Totality guard, bidirectional: every schema column must be projected onto
// the response or explicitly excused above, and the projection cannot carry
// a field that traces back to no real column.
type MissingProjectedPlaybookListColumn = UnprojectedColumns<
  PlaybookDefinitionRow,
  PlaybookDefinitionListItem,
  (typeof UNPROJECTED_PLAYBOOK_LIST_COLUMNS)[number]
>;
type UnexpectedProjectedPlaybookListColumn = UnbackedProjectionKeys<
  PlaybookDefinitionRow,
  PlaybookDefinitionListItem,
  (typeof UNPROJECTED_PLAYBOOK_LIST_COLUMNS)[number]
>;

true satisfies MissingProjectedPlaybookListColumn extends never ? true : never;
true satisfies UnexpectedProjectedPlaybookListColumn extends never
  ? true
  : never;

export const listPlaybookDefinitionsQuerySchema = t.Object({
  limit: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: LIMITS.playbookDefinitionsPageSizeMax,
      description: "Max playbooks to return",
    }),
  ),
  cursor: t.Optional(
    t.String({
      maxLength: 512,
      description:
        "Opaque cursor from a previous list_playbooks call to fetch the next page",
    }),
  ),
});

// The cursor is the boundary row id alone; the query resolves that row's exact
// (created_at, id) in-DB so the comparison stays at the column's microsecond
// precision instead of a millisecond-truncated JS Date (rows sharing a
// millisecond cannot be skipped or duplicated).
const decodePlaybookDefinitionCursor = (
  cursor: string,
): SafeId<"playbookDefinition"> | null => {
  const parts = decodePaginationCursor(cursor);
  if (!parts || parts.length !== 1) {
    return null;
  }
  const [rawId] = parts;
  if (!isUuidPaginationCursorPart(rawId)) {
    return null;
  }
  return brandPersistedPlaybookDefinitionId(rawId);
};

type ListPlaybookDefinitionsProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  query: {
    limit?: number;
    cursor?: string;
  };
};

export const listPlaybookDefinitionsHandler = async function* ({
  safeDb,
  organizationId,
  query,
}: ListPlaybookDefinitionsProps) {
  const limit = query.limit ?? LIMITS.playbookDefinitionsPageSizeDefault;
  const conditions = [eq(playbookDefinitions.organizationId, organizationId)];

  if (query.cursor) {
    const cursor = decodePlaybookDefinitionCursor(query.cursor);
    if (!cursor) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }
    // Fail fast on a stale or cross-org boundary id: the in-DB subquery below
    // resolves to NULL for a missing row, which would silently filter out every
    // row and return an empty page instead of a 400.
    const boundary = yield* Result.await(
      safeDb((tx) =>
        tx.query.playbookDefinitions.findFirst({
          where: {
            id: { eq: cursor },
            organizationId: { eq: organizationId },
          },
          columns: { id: true },
        }),
      ),
    );
    if (!boundary) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }
    conditions.push(
      sql`(${playbookDefinitions.createdAt}, ${playbookDefinitions.id}) < (select b.created_at, b.id from playbook_definitions b where b.id = ${cursor} and b.organization_id = ${organizationId})`,
    );
  }

  const rows = yield* Result.await(
    safeDb((tx) =>
      tx
        .select({
          id: playbookDefinitions.id,
          name: playbookDefinitions.name,
          description: playbookDefinitions.description,
          status: playbookDefinitions.status,
          createdAt: playbookDefinitions.createdAt,
          updatedAt: playbookDefinitions.updatedAt,
        })
        .from(playbookDefinitions)
        .where(and(...conditions))
        .orderBy(
          desc(playbookDefinitions.createdAt),
          desc(playbookDefinitions.id),
        )
        .limit(limit + 1),
    ),
  );

  const page = createCursorPage({
    rows,
    limit,
    cursorForItem: (item) => encodePaginationCursor([item.id]),
  });

  return Result.ok({
    ...page,
    items: page.items.map(toPlaybookDefinitionListItem),
  });
};

// ── Get ─────────────────────────────────────────────

// Columns intentionally not sent by the detail read. A new schema column
// must either be projected by `toPlaybookDefinitionDetail` below or added
// here with a reason, or the totality check further down fails to
// typecheck.
const UNPROJECTED_PLAYBOOK_DETAIL_COLUMNS = [
  // Tenant scope, implied by the caller's active organization.
  "organizationId",
  // Server-only bundled-starter correlation id; never read back.
  "starterId",
  // unprojected as of 2026-09-02; review — set on approval
  // (`playbooks/approve.ts`) but never read back to the client anywhere;
  // possibly a real gap ("approved by whom") rather than deliberate.
  "approvedBy",
] as const satisfies readonly (keyof PlaybookDefinitionRow)[];

// The shape the get `columns: {...}` query below must project.
type PlaybookDefinitionDetailRow = Pick<
  PlaybookDefinitionRow,
  | "id"
  | "name"
  | "description"
  | "scope"
  | "positions"
  | "status"
  | "approvedAt"
  | "createdAt"
  | "updatedAt"
>;

const toPlaybookDefinitionDetail = (row: PlaybookDefinitionDetailRow) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  scope: row.scope,
  positions: row.positions,
  status: row.status,
  approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

type PlaybookDefinitionDetail = ReturnType<typeof toPlaybookDefinitionDetail>;

// Totality guard, bidirectional: every schema column must be projected onto
// the response or explicitly excused above, and the projection cannot carry
// a field that traces back to no real column.
type MissingProjectedPlaybookDetailColumn = UnprojectedColumns<
  PlaybookDefinitionRow,
  PlaybookDefinitionDetail,
  (typeof UNPROJECTED_PLAYBOOK_DETAIL_COLUMNS)[number]
>;
type UnexpectedProjectedPlaybookDetailColumn = UnbackedProjectionKeys<
  PlaybookDefinitionRow,
  PlaybookDefinitionDetail,
  (typeof UNPROJECTED_PLAYBOOK_DETAIL_COLUMNS)[number]
>;

true satisfies MissingProjectedPlaybookDetailColumn extends never
  ? true
  : never;
true satisfies UnexpectedProjectedPlaybookDetailColumn extends never
  ? true
  : never;

type GetPlaybookDefinitionProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  playbookId: SafeId<"playbookDefinition">;
};

export const getPlaybookDefinitionHandler = async function* ({
  safeDb,
  organizationId,
  playbookId,
}: GetPlaybookDefinitionProps) {
  const playbook = yield* Result.await(
    safeDb((tx) =>
      tx.query.playbookDefinitions.findFirst({
        where: {
          id: { eq: playbookId },
          organizationId: { eq: organizationId },
        },
        columns: {
          id: true,
          name: true,
          description: true,
          scope: true,
          positions: true,
          status: true,
          approvedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    ),
  );

  if (!playbook) {
    return Result.err(
      new HandlerError({ status: 404, message: "Playbook not found" }),
    );
  }

  return Result.ok(toPlaybookDefinitionDetail(playbook));
};
