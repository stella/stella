import { treaty } from "@elysia/eden";
import type { Treaty } from "@elysia/eden";
import type {
  AnyElysia,
  DefaultEphemeral,
  DefaultMetadata,
  DefaultSingleton,
  Elysia,
  RouteBase,
} from "elysia";

export type StellaEdenClientOptions = Omit<Treaty.Config, "parseDate">;

/** An app type carrying only a route tree: the one part Eden's treaty reads. */
type RoutesOnlyElysia<TRoutes extends RouteBase> = Elysia<
  "",
  "local",
  DefaultSingleton,
  { typebox: Record<never, never>; error: [] },
  DefaultMetadata,
  TRoutes,
  DefaultEphemeral,
  DefaultEphemeral
>;

export type EdenRoutesApp<TRoutes extends RouteBase> =
  RoutesOnlyElysia<TRoutes>;

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
