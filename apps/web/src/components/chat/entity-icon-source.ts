import { skipToken, useQuery } from "@tanstack/react-query";

import type { EntityIconSource } from "@/components/workspaces/entity-kind-icon";
import { entityOptions } from "@/lib/workspaces/queries/entities";

/**
 * Resolve a chat mention's entity to an icon source.
 *
 * A mention href carries only `workspaceId:entityId`, so the kind has to
 * come from the entity itself; the label is the entity's name and says
 * nothing about what it is. Rendering starts before the query settles, and
 * `pending` keeps that moment honest instead of guessing a glyph.
 */
export const useEntityIconSource = ({
  entityId,
  workspaceId,
}: {
  entityId: string | undefined;
  workspaceId: string | undefined;
}): EntityIconSource => {
  // staleTime: Infinity — one fetch per entity ref; later renders and the
  // click handler read the same cache entry, so a thread full of mentions
  // stays cheap.
  const { data, isError } = useQuery({
    ...(workspaceId && entityId
      ? entityOptions(workspaceId, entityId)
      : {
          queryKey: ["mention-entity-disabled"] as const,
          queryFn: skipToken,
        }),
    enabled: workspaceId !== undefined && entityId !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
  });

  if (!workspaceId || !entityId || isError) {
    return { type: "unknown" };
  }

  if (!data) {
    return { type: "pending" };
  }

  for (const field of data.fields) {
    if (field.content.type === "file" && field.content.mimeType.length > 0) {
      return {
        type: "resolved",
        kind: data.kind,
        fileName: field.content.fileName,
        mimeType: field.content.mimeType,
      };
    }
  }

  return { type: "resolved", kind: data.kind };
};
