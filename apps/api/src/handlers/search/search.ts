import { status, t, type Static } from "elysia";

import { db } from "@/api/db";
import { entityKindSchema } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import { getSearchProvider } from "@/api/lib/search/provider";

export const searchBodySchema = t.Object({
  query: t.String({
    minLength: 1,
    maxLength: LIMITS.searchQueryMaxLength,
  }),
  workspaceId: t.Optional(tNanoid),
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
  organizationId: SafeId<"organization">;
  body: SearchBodySchema;
};

export const searchHandler = async ({
  organizationId,
  body,
}: SearchHandlerProps) => {
  // Validate workspace belongs to the caller's organization
  if (body.workspaceId) {
    const ws = await db.query.workspaces.findFirst({
      where: { id: body.workspaceId, organizationId },
      columns: { id: true },
    });
    if (!ws) {
      return status(400, {
        message: "Workspace not found in organization",
      });
    }
  }

  const provider = getSearchProvider();
  return provider.search({
    query: body.query,
    organizationId,
    workspaceId: body.workspaceId,
    kinds: body.kinds,
    cursor: body.cursor,
    limit: body.limit ?? LIMITS.searchPageSizeDefault,
  });
};
