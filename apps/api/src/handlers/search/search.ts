import { status, t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { entityKindSchema } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";
import { tUuid } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";
import { getSearchProvider } from "@/api/lib/search/provider";

export const searchBodySchema = t.Object({
  query: t.String({
    minLength: 1,
    maxLength: LIMITS.searchQueryMaxLength,
  }),
  workspaceId: t.Optional(tUuid),
  kinds: t.Optional(t.Array(entityKindSchema)),
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
          id: body.workspaceId,
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
    workspaceId = brandPersistedWorkspaceId(ws.id);
  }

  const provider = getSearchProvider();
  return provider.search({
    query: body.query,
    organizationId,
    workspaceIds: accessibleWorkspaceIds,
    workspaceId,
    kinds: body.kinds,
    cursor: body.cursor,
    limit: body.limit ?? LIMITS.searchPageSizeDefault,
  });
};
