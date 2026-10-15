import type { UseQueryResult } from "@tanstack/react-query";
import { panic } from "better-result";

// Preserve TanStack's status/data/error correlation when projecting its result.
type QueryViewQuery<TData, TError> = {
  [Status in UseQueryResult<TData, TError>["status"]]: Pick<
    Extract<UseQueryResult<TData, TError>, { status: Status }>,
    | "status"
    | "fetchStatus"
    | "data"
    | "error"
    | "refetch"
    | "isPlaceholderData"
  >;
}[UseQueryResult<TData, TError>["status"]];

export type QueryView<TData, TError> =
  | { type: "pending" }
  | {
      type: "error";
      error: TError;
      retry: UseQueryResult<TData, TError>["refetch"];
    }
  | { type: "empty" }
  | {
      type: "items";
      items: TData;
      retry: UseQueryResult<TData, TError>["refetch"];
      refetchError?: TError;
    };

export type QueryViewOptions<TData> = {
  isEmpty?: (items: TData) => boolean;
};

export const queryViewError = <TData, TError>(
  view: QueryView<TData, TError>,
): TError | undefined => {
  switch (view.type) {
    case "error":
      return view.error;
    case "items":
      return view.refetchError;
    case "pending":
    case "empty":
      return undefined;
    default:
      view satisfies never;
      return panic("Unhandled query view status");
  }
};

export const queryView = <TData, TError>(
  query: QueryViewQuery<TData, TError>,
  {
    isEmpty = (items) => Array.isArray(items) && items.length === 0,
  }: QueryViewOptions<TData> = {},
): QueryView<TData, TError> => {
  switch (query.status) {
    case "pending":
      return { type: "pending" };
    case "error":
      if (query.data === undefined) {
        return { type: "error", error: query.error, retry: query.refetch };
      }
      // Even cached zero-item data must not turn a failed refetch into empty.
      return {
        type: "items",
        items: query.data,
        retry: query.refetch,
        refetchError: query.error,
      };
    case "success":
      if (isEmpty(query.data)) {
        return query.isPlaceholderData
          ? { type: "pending" }
          : { type: "empty" };
      }
      return { type: "items", items: query.data, retry: query.refetch };
    default:
      query satisfies never;
      return panic("Unhandled query view status");
  }
};
