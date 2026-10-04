import { useQuery } from "@tanstack/react-query";

import type { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import {
  templateDetailOptions,
  templateClausesOptions,
  templateFillDiscoverOptions,
  templateClauseSourceStamp,
} from "@/lib/knowledge/queries";

/**
 * The fillable shape of a *saved* template, for hosts that render the fill
 * form outside the Studio: load the template detail (presigned source URL),
 * re-discover stored fields server-side — the same merge the
 * fill endpoint applies, so `{% for %}` array fields and manifest metadata
 * are both present. Shares the `templateFillDiscoverOptions` cache entry with
 * the Studio fill tab.
 */

type DiscoverResponse = Awaited<ReturnType<typeof api.templates.discover.post>>;

type DiscoverData = Exclude<
  NonNullable<Extract<DiscoverResponse, { data: unknown }>["data"]>,
  Response
>;

type TemplateFillSchema =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ready"; fileName: string; schema: DiscoverData };

export const useTemplateFillSchema = (
  templateId: string,
): TemplateFillSchema => {
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;

  const detailOptions = templateDetailOptions(activeOrganizationId, templateId);
  const { data: detailData, isError: detailError } = useQuery(detailOptions);
  const detail =
    detailData && !(detailData instanceof Response) && "manifest" in detailData
      ? detailData
      : null;

  const { data: clauseSources, isError: clauseSourcesError } = useQuery(
    templateClausesOptions(activeOrganizationId, templateId),
  );
  const sourceStamp =
    clauseSources && "links" in clauseSources
      ? templateClauseSourceStamp(clauseSources.links)
      : undefined;

  const {
    data: discovered,
    isError: discoverError,
    isLoading: discovering,
  } = useQuery(
    templateFillDiscoverOptions({
      key: {
        organizationId: activeOrganizationId,
        templateId,
        sourceStamp: sourceStamp ?? "",
      },
      context: {
        presignedUrl:
          sourceStamp === undefined ? undefined : detail?.presignedUrl,
        fileName: detail?.fileName,
      },
    }),
  );

  if (detailError || discoverError || clauseSourcesError) {
    return { state: "error" };
  }
  if (!detail || discovering || !discovered) {
    return { state: "loading" };
  }
  return { state: "ready", fileName: detail.fileName, schema: discovered };
};
