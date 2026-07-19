import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";

import type { api } from "@/lib/api";
import {
  templateDetailOptions,
  templateFillDiscoverOptions,
} from "@/routes/_protected.knowledge/-queries";

/**
 * The fillable shape of a *saved* template, for hosts that render the fill
 * form outside the Studio: load the template detail (presigned source URL),
 * fetch the bytes, and re-discover fields server-side — the same merge the
 * fill endpoint applies, so `{{#each}}` array fields and manifest metadata
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

const protectedRouteApi = getRouteApi("/_protected");

export const useTemplateFillSchema = (
  templateId: string,
): TemplateFillSchema => {
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });

  const detailOptions = templateDetailOptions(activeOrganizationId, templateId);
  const { data: detailData, isError: detailError } = useQuery(detailOptions);
  const detail =
    detailData && !(detailData instanceof Response) && "manifest" in detailData
      ? detailData
      : null;

  const {
    data: discovered,
    isError: discoverError,
    isLoading: discovering,
  } = useQuery(
    templateFillDiscoverOptions({
      key: { organizationId: activeOrganizationId, templateId },
      context: {
        presignedUrl: detail?.presignedUrl,
        fileName: detail?.fileName,
      },
    }),
  );

  if (detailError || discoverError) {
    return { state: "error" };
  }
  if (!detail || discovering || !discovered) {
    return { state: "loading" };
  }
  return { state: "ready", fileName: detail.fileName, schema: discovered };
};
