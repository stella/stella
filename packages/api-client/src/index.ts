import { treaty } from "@elysiajs/eden";
import type { Treaty } from "@elysiajs/eden";
import type { AnyElysia } from "elysia";

export type StellaEdenClientOptions = Omit<Treaty.Config, "parseDate">;

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
