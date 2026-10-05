import { Result } from "better-result";
import { and, asc, eq, gt, or } from "drizzle-orm";
import { t } from "elysia";

import { savedTimeNarratives } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tPaginationCursor, tPaginationLimit } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
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
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { brandPersistedSavedTimeNarrativeId } from "@/api/lib/safe-id-boundaries";

import { toSavedTimeNarrativeItem } from "./schema";

type SavedTimeNarrativeRow = typeof savedTimeNarratives.$inferSelect;

const UNPROJECTED_SAVED_TIME_NARRATIVE_COLUMNS = [
  // Both ownership fields are implied by the active organization and user.
  "organizationId",
  "userId",
] as const satisfies readonly (keyof SavedTimeNarrativeRow)[];

type MissingSavedTimeNarrativeColumn = UnprojectedColumns<
  SavedTimeNarrativeRow,
  ReturnType<typeof toSavedTimeNarrativeItem>,
  (typeof UNPROJECTED_SAVED_TIME_NARRATIVE_COLUMNS)[number]
>;
type UnexpectedSavedTimeNarrativeColumn = UnbackedProjectionKeys<
  SavedTimeNarrativeRow,
  ReturnType<typeof toSavedTimeNarrativeItem>,
  (typeof UNPROJECTED_SAVED_TIME_NARRATIVE_COLUMNS)[number]
>;

true satisfies MissingSavedTimeNarrativeColumn extends never ? true : never;
true satisfies UnexpectedSavedTimeNarrativeColumn extends never ? true : never;

const config = {
  description:
    "List the signed-in user's saved time narratives in the active organization, ordered by name with cursor pagination.",
  permissions: { timeEntry: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  featureAccess: { featureId: "time-billing", type: "required" },
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "billing_admin",
    consumesServices: false,
  },
  access: "read",
  query: t.Object({
    limit: t.Optional(tPaginationLimit(100)),
    cursor: t.Optional(tPaginationCursor()),
  }),
} satisfies HandlerConfig;

const listSavedTimeNarratives = createSafeRootHandler(
  config,
  async function* ({ query, safeDb, session, user }) {
    const limit = normalizeTenantPageLimit(query.limit ?? 50);
    const conditions = [
      eq(savedTimeNarratives.organizationId, session.activeOrganizationId),
      eq(savedTimeNarratives.userId, user.id),
    ];
    if (query.cursor) {
      const parts = decodePaginationCursor(query.cursor);
      const name = parts?.at(0);
      const id = parts?.at(1);
      if (
        parts?.length !== 2 ||
        typeof name !== "string" ||
        !isUuidPaginationCursorPart(id)
      ) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid cursor" }),
        );
      }
      const after = or(
        gt(savedTimeNarratives.name, name),
        and(
          eq(savedTimeNarratives.name, name),
          gt(savedTimeNarratives.id, brandPersistedSavedTimeNarrativeId(id)),
        ),
      );
      if (after) {
        conditions.push(after);
      }
    }
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: savedTimeNarratives.id,
            name: savedTimeNarratives.name,
            narrative: savedTimeNarratives.narrative,
            narrativeLanguage: savedTimeNarratives.narrativeLanguage,
            createdAt: savedTimeNarratives.createdAt,
            updatedAt: savedTimeNarratives.updatedAt,
          })
          .from(savedTimeNarratives)
          .where(and(...conditions))
          .orderBy(asc(savedTimeNarratives.name), asc(savedTimeNarratives.id))
          .limit(limit + 1),
      ),
    );
    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: (item) => encodePaginationCursor([item.name, item.id]),
    });
    return Result.ok({
      ...page,
      items: page.items.map(toSavedTimeNarrativeItem),
    });
  },
);

export default listSavedTimeNarratives;
