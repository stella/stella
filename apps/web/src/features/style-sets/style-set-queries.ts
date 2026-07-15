import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { STALE_TIME } from "@/lib/consts";
import { toAPIError } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";

const STYLE_SETS_PAGE_SIZE = 100;

type StyleSetEditorKey = {
  organizationId: string;
  styleSetId: string;
};

export const styleSetsKeys = {
  all: (organizationId: string) => ["style-sets", organizationId],
  list: (organizationId: string) => [
    ...styleSetsKeys.all(organizationId),
    "list",
  ],
  editor: ({ organizationId, styleSetId }: StyleSetEditorKey) => [
    ...styleSetsKeys.all(organizationId),
    "editor",
    styleSetId,
  ],
  stellaEditor: (organizationId: string) => [
    ...styleSetsKeys.all(organizationId),
    "editor",
    "stella",
  ],
};

export const styleSetsOptions = (organizationId: string) =>
  queryOptions({
    queryKey: styleSetsKeys.list(organizationId),
    queryFn: async ({ signal }) => {
      const response = await api["style-sets"].get({
        query: { limit: STYLE_SETS_PAGE_SIZE },
        fetch: { signal },
      });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

export const styleSetEditorOptions = ({
  organizationId,
  styleSetId,
}: StyleSetEditorKey) =>
  queryOptions({
    queryKey: styleSetsKeys.editor({ organizationId, styleSetId }),
    queryFn: async ({ signal }) => {
      const response = await api["style-sets"]({
        styleSetId: toSafeId<"styleSet">(styleSetId),
      }).editor.get({ fetch: { signal } });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

export const stellaStyleEditorOptions = (organizationId: string) =>
  queryOptions({
    queryKey: styleSetsKeys.stellaEditor(organizationId),
    queryFn: async ({ signal }) => {
      const response = await api["style-sets"].editor.stella.get({
        fetch: { signal },
      });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });
