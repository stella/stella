import { status, t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { entityKindSchema } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, tUserId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import { searchGlobal } from "@/api/lib/search/index-global";
import { GLOBAL_SEARCH_RESULT_TYPES } from "@/api/lib/search/types";
import type { GlobalSearchUpdatedWithin } from "@/api/lib/search/types";

export const updatedWithinSchema = t.Union([
  t.Literal("day"),
  t.Literal("week"),
  t.Literal("month"),
  t.Literal("year"),
]);

export const searchBodySchema = t.Object({
  query: t.String({
    minLength: 1,
    maxLength: LIMITS.searchQueryMaxLength,
  }),
  workspaceId: t.Optional(tSafeId("workspace")),
  types: t.Optional(t.Array(t.UnionEnum(GLOBAL_SEARCH_RESULT_TYPES))),
  kinds: t.Optional(t.Array(entityKindSchema)),
  editedByUserId: t.Optional(tUserId),
  mimeTypes: t.Optional(t.Array(t.String({ minLength: 1, maxLength: 128 }))),
  updatedWithin: t.Optional(updatedWithinSchema),
  cursor: t.Optional(t.String()),
  limit: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: LIMITS.searchPageSizeMax,
      default: LIMITS.searchPageSizeDefault,
    }),
  ),
});

type SearchBodySchema = Static<typeof searchBodySchema>;

const UPDATED_WITHIN_MS = {
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
  year: 365 * 86_400_000,
} as const satisfies Record<GlobalSearchUpdatedWithin, number>;

export const resolveUpdatedAfter = (
  updatedWithin: GlobalSearchUpdatedWithin | undefined,
): string | undefined => {
  if (!updatedWithin) {
    return undefined;
  }
  return new Date(Date.now() - UPDATED_WITHIN_MS[updatedWithin]).toISOString();
};

type SearchHandlerProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  accessibleWorkspaceIds: SafeId<"workspace">[];
  body: SearchBodySchema;
};

export const searchHandler = async ({
  scopedDb,
  organizationId,
  accessibleWorkspaceIds,
  body,
}: SearchHandlerProps) => {
  let workspaceId: SafeId<"workspace"> | undefined;

  // Validate workspace belongs to the caller's organization and is not being deleted
  if (body.workspaceId) {
    const ws = await scopedDb((tx) =>
      tx.query.workspaces.findFirst({
        where: {
          id: { eq: body.workspaceId },
          organizationId: { eq: organizationId },
          status: { ne: "deleting" },
        },
        columns: { id: true },
      }),
    );
    if (!ws) {
      return status(400, {
        message: "Workspace not found in organization",
      });
    }
    workspaceId = ws.id;
  }

  const types = body.types ?? body.kinds;

  return await searchGlobal({
    query: body.query,
    organizationId,
    workspaceIds: accessibleWorkspaceIds,
    workspaceId,
    types,
    editedByUserId: body.editedByUserId,
    mimeTypes: body.mimeTypes,
    updatedAfter: resolveUpdatedAfter(body.updatedWithin),
    cursor: body.cursor,
    limit: body.limit ?? LIMITS.searchPageSizeDefault,
  });
};
