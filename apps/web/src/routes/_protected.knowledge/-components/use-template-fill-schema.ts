import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { panic } from "better-result";

import { api } from "@/lib/api";
import { DOCX_MIME } from "@/lib/consts";
import { toAPIError } from "@/lib/errors";
import { templateDetailOptions } from "@/routes/_protected.knowledge/-queries";

/**
 * The fillable shape of a *saved* template, for hosts that render the fill
 * form outside the Studio: load the template detail (presigned source URL),
 * fetch the bytes, and re-discover fields server-side — the same merge the
 * fill endpoint applies, so `{{#each}}` array fields and manifest metadata
 * are both present.
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

  const presignedUrl = detail?.presignedUrl;
  const fileName = detail?.fileName;
  const {
    data: discovered,
    isError: discoverError,
    isLoading: discovering,
  } = useQuery({
    queryKey: [
      ...detailOptions.queryKey,
      "fill-discover",
      presignedUrl,
      fileName,
    ],
    queryFn: async () => {
      if (presignedUrl === undefined || fileName === undefined) {
        panic("template fill: saved template document is unavailable");
      }
      const res = await fetch(presignedUrl, {
        signal: AbortSignal.timeout(15_000),
      });
      const blob = await res.blob();
      const file = new File([blob], fileName, { type: DOCX_MIME });
      const response = await api.templates.discover.post({ file });
      if (response.error) {
        throw toAPIError(response.error);
      }
      if (response.data instanceof Response) {
        panic("template fill: discover returned a raw response");
      }
      return response.data;
    },
    enabled: presignedUrl !== undefined && fileName !== undefined,
  });

  if (detailError || discoverError) {
    return { state: "error" };
  }
  if (!detail || discovering || !discovered) {
    return { state: "loading" };
  }
  return { state: "ready", fileName: detail.fileName, schema: discovered };
};
