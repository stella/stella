import { queryOptions } from "@tanstack/react-query";
import { Result } from "better-result";

import { getAnalytics } from "@/lib/analytics/provider";
import { linkIconsApi } from "@/lib/api";
import { ClientOperationError } from "@/lib/errors/client";

const LINK_ICON_REQUEST_TIMEOUT_MS = 5000;
const LINK_ICON_CACHE_MS = 60 * 60 * 1000;

type LinkIcon =
  | { type: "icon"; blob: Blob }
  | { type: "no-icon" }
  | { type: "temporary" };

export const linkIconOptions = (hostname: string) =>
  queryOptions({
    queryKey: ["chat-link-icon", hostname],
    retry: false,
    gcTime: 60 * 1000,
    queryFn: async ({ signal }): Promise<LinkIcon> => {
      const result = await Result.tryPromise(async () =>
        linkIconsApi({ hostname }).get({
          fetch: {
            signal: AbortSignal.any([
              signal,
              AbortSignal.timeout(LINK_ICON_REQUEST_TIMEOUT_MS),
            ]),
          },
        }),
      );
      if (Result.isError(result) || result.value.error) {
        getAnalytics().captureError(
          new ClientOperationError({
            action: "readLinkIcon",
            message: "Link icon unavailable",
            cause: Result.isError(result) ? result.error : result.value.error,
          }),
        );
        return { type: "temporary" };
      }
      const bytes = result.value.data;
      if (!(bytes instanceof Blob)) {
        return bytes.type === "no-icon"
          ? { type: "no-icon" }
          : { type: "temporary" };
      }
      if (
        bytes.size > 64 * 1024 ||
        (bytes.type !== "image/png" && bytes.type !== "image/x-icon")
      ) {
        getAnalytics().captureError(
          new ClientOperationError({
            action: "readLinkIcon",
            message: "Unexpected link icon response",
          }),
        );
        return { type: "temporary" };
      }
      return { type: "icon", blob: bytes };
    },
    staleTime: (query) =>
      query.state.data?.type === "temporary" ? 0 : LINK_ICON_CACHE_MS,
  });
