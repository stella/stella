import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapPublicLawResponse } from "@/lib/public-law-api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";

const READ_GUIDANCE_ACTION = "readGuidanceDocument";

export const guidanceDocumentOptions = (documentId: string) =>
  queryOptions({
    queryKey: ["guidance", "document", documentId],
    queryFn: async ({ signal }) =>
      unwrapPublicLawResponse(
        await api["soft-law"]({
          documentId: toSafeId<"softLawDocument">(documentId),
        }).get({ fetch: { signal } }),
        READ_GUIDANCE_ACTION,
      ),
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
