import { treaty } from "@elysia/eden";
import type { Treaty } from "@elysia/eden";
import type { AnyElysia, Elysia, RouteBase } from "elysia";

import {
  createScopedResponseTransport,
  type ScopedResponseObserver,
} from "./scoped-response";

export type StellaEdenClientOptions = Omit<Treaty.Config, "parseDate"> & {
  onScopedResponse?: ScopedResponseObserver;
};

type EmptyElysia = Elysia;

/** An app type carrying only a route tree: the one part Eden's treaty reads. */
export type EdenRoutesApp<TRoutes extends RouteBase> = Elysia<
  EmptyElysia["~Prefix"],
  EmptyElysia["~Singleton"],
  EmptyElysia["~Definitions"],
  EmptyElysia["~Metadata"],
  TRoutes
>;

/** Creates the versioned typed API client with shared transport defaults. */
export const createStellaEdenClient = <TApi extends AnyElysia>(
  origin: string,
  options: StellaEdenClientOptions = {},
) => {
  const { fetch, onScopedResponse, ...config } = options;
  const defaultFetcher = Object.assign(
    async (
      input: Parameters<typeof globalThis.fetch>[0],
      init: Parameters<typeof globalThis.fetch>[1],
    ) => await globalThis.fetch(input, init),
    { preconnect: globalThis.fetch.preconnect },
  );
  const scoped =
    onScopedResponse === undefined
      ? undefined
      : createScopedResponseTransport({
          fetcher: config.fetcher ?? defaultFetcher,
          observer: onScopedResponse,
        });

  const client = treaty<TApi>(origin, {
    ...config,
    ...(scoped === undefined ? {} : { fetcher: scoped.fetcher }),
    fetch: {
      ...fetch,
      credentials: fetch?.credentials ?? "include",
    },
    // API timestamps are serialized strings. Keep every client consistent and
    // avoid changing their runtime shape based on Eden's date parser.
    parseDate: false,
  });
  return scoped === undefined ? client : scoped.wrapClient(client);
};
