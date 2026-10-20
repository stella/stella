import { treaty } from "@elysia/eden";
import type { Treaty } from "@elysia/eden";
import type { AnyElysia, Elysia, RouteBase } from "elysia";

export type StellaEdenClientOptions = Omit<Treaty.Config, "parseDate">;

/** An app type carrying only a route tree: the one part Eden's treaty reads. */
export type EdenRoutesApp<TRoutes extends RouteBase> = Elysia<
  "",
  {
    decorator: Record<never, never>;
    store: Record<never, never>;
    derive: Record<never, never>;
    resolve: Record<never, never>;
  },
  { typebox: Record<never, never>; error: Record<never, never> },
  {
    schema: Record<never, never>;
    standaloneSchema: Record<never, never>;
    macro: Record<never, never>;
    macroFn: Record<never, never>;
    parser: Record<never, never>;
    response: Record<never, never>;
  },
  TRoutes
>;

/** Creates the versioned typed API client with shared transport defaults. */
export const createStellaEdenClient = <TApi extends AnyElysia>(
  origin: string,
  options: StellaEdenClientOptions = {},
) => {
  const { fetch, ...config } = options;

  return treaty<TApi>(origin, {
    ...config,
    fetch: {
      ...fetch,
      credentials: fetch?.credentials ?? "include",
    },
    // API timestamps are serialized strings. Keep every client consistent and
    // avoid changing their runtime shape based on Eden's date parser.
    parseDate: false,
  });
};
