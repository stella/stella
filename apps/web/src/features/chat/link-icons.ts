import { queryOptions } from "@tanstack/react-query";
import { Result } from "better-result";

import { getAnalytics } from "@/lib/analytics/provider";
import { linkIconsApi } from "@/lib/api";
import { ClientOperationError } from "@/lib/errors/client";

const LINK_ICON_REQUEST_TIMEOUT_MS = 5000;

export const linkIconOptions = (hostname: string) =>
  queryOptions({
    queryKey: ["chat-link-icon", hostname],
    retry: false,
    staleTime: 60 * 60 * 1000,
    gcTime: 60 * 1000,
    queryFn: async ({ signal }) => {
      const result = await Result.tryPromise(async () => {
        const response = await linkIconsApi({ hostname }).get({
          fetch: {
            signal: AbortSignal.any([
              signal,
              AbortSignal.timeout(LINK_ICON_REQUEST_TIMEOUT_MS),
            ]),
          },
        });
        if (response.error) {
          throw new ClientOperationError({
            action: "readLinkIcon",
            message: "Link icon request failed",
          });
        }
        const bytes = response.data;
        if (!(bytes instanceof Blob)) {
          return null;
        }
        if (
          bytes.size > 64 * 1024 ||
          (bytes.type !== "image/png" && bytes.type !== "image/x-icon")
        ) {
          throw new ClientOperationError({
            action: "readLinkIcon",
            message: "Unexpected link icon response",
          });
        }
        return bytes;
      });
      if (Result.isError(result)) {
        getAnalytics().captureError(
          new ClientOperationError({
            action: "readLinkIcon",
            message: "Link icon unavailable",
            cause: result.error,
          }),
        );
        return null;
      }
      return result.value;
    },
  });
