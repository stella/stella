import { queryOptions } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { panic, Result } from "better-result";

import { captureQueryError } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { ClientOperationError } from "@/lib/errors/client";

const LINK_ICON_REQUEST_TIMEOUT_MS = 5000;
const LINK_ICON_CACHE_MS = 60 * 60 * 1000;
const LINK_ICON_MAX_ATTEMPTS = 4;
const LINK_ICON_RETRY_DELAY_MS = 2000;

type LinkIcon =
  | { type: "icon"; blob: Blob }
  | { type: "no-icon" }
  | { type: "temporary"; attempt: number };

export const linkIconOptions = (hostname: string) =>
  iconOptions({ type: "hostname", value: hostname });

export const exactIconOptions = (url: string) =>
  iconOptions({ type: "url", value: url });

type IconTarget =
  { type: "hostname"; value: string } | { type: "url"; value: string };

function iconOptions(target: IconTarget) {
  const options = queryOptions({
    queryKey: ["chat-link-icon", target.type, target.value],
    retry: false,
    gcTime: 60 * 1000,
    queryFn: async ({ signal, client }): Promise<LinkIcon> => {
      const temporary = nextTemporaryOutcome(client);
      const routeTemplate =
        target.type === "hostname"
          ? "/v1/chat/link-icons/:hostname"
          : "/v1/chat/link-icons/exact";
      const unavailable = (cause: unknown) => {
        captureQueryError(
          new ClientOperationError({
            action: "readLinkIcon",
            message: "Link icon unavailable",
            cause,
          }),
          {
            fingerprintKey: "linkIconOptions:request",
            scope: { type: "request", method: "GET", routeTemplate },
          },
        );
        return temporary;
      };
      const fetched = await Result.tryPromise(async () => {
        const fetch = {
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(LINK_ICON_REQUEST_TIMEOUT_MS),
          ]),
        };
        const response =
          target.type === "hostname"
            ? await api.chat["link-icons"]({ hostname: target.value }).get({
                fetch,
              })
            : await api.chat["link-icons"].exact.get({
                query: { url: target.value },
                fetch,
              });
        return response.error === null
          ? Result.ok(response.data)
          : Result.err(response.error);
      });
      if (Result.isError(fetched)) {
        return unavailable(fetched.error);
      }
      const answer = fetched.value;
      if (Result.isError(answer)) {
        return unavailable(answer.error);
      }
      const bytes = answer.value;
      if (!(bytes instanceof Blob)) {
        switch (bytes.type) {
          case "no-icon":
            return { type: "no-icon" };
          case "temporary":
            return temporary;
          default:
            bytes satisfies never;
            return panic("Unhandled link icon wire outcome");
        }
      }
      if (
        bytes.size > 64 * 1024 ||
        (bytes.type !== "image/png" && bytes.type !== "image/x-icon")
      ) {
        captureQueryError(
          new ClientOperationError({
            action: "readLinkIcon",
            message: "Unexpected link icon response",
          }),
          {
            fingerprintKey: "linkIconOptions:response",
            scope: {
              type: "request",
              method: "GET",
              routeTemplate,
            },
          },
        );
        return temporary;
      }
      return { type: "icon", blob: bytes };
    },
  });
  const nextTemporaryOutcome = (client: QueryClient) => {
    const previous = client.getQueryData(options.queryKey);
    return {
      type: "temporary",
      attempt: previous?.type === "temporary" ? previous.attempt + 1 : 1,
    } as const;
  };
  return queryOptions({
    ...options,
    staleTime: ({ state: { data } }) => {
      if (data === undefined) {
        return 0;
      }
      switch (data.type) {
        case "temporary":
          return 0;
        case "icon":
        case "no-icon":
          return LINK_ICON_CACHE_MS;
        default:
          data satisfies never;
          return panic("Unhandled link icon cache outcome");
      }
    },
    refetchInterval: ({ state: { data } }) => {
      if (data === undefined) {
        return false;
      }
      switch (data.type) {
        case "temporary":
          // The last retry runs at 14s, beyond the server's 10s fetch lease.
          return data.attempt >= LINK_ICON_MAX_ATTEMPTS
            ? false
            : LINK_ICON_RETRY_DELAY_MS * 2 ** (data.attempt - 1);
        case "icon":
        case "no-icon":
          return false;
        default:
          data satisfies never;
          return panic("Unhandled link icon retry outcome");
      }
    },
  });
}
