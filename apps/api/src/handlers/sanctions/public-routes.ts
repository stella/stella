import Elysia from "elysia";

import publicSanctionsSearch, {
  createPublicSanctionsSearchHandler,
} from "@/api/handlers/sanctions/search";
import type { PublicSanctionsSearchOptions } from "@/api/handlers/sanctions/search";
import { createPublicSanctionsRateLimitOptions } from "@/api/lib/rate-limit/public-corpus-rate-limits";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import type { RateLimitOptions } from "@/api/lib/rate-limit/rate-limit";
import { applyResponseCachePolicy } from "@/api/lib/security-headers";

type PublicSanctionsRouteOptions = PublicSanctionsSearchOptions & {
  rateLimitOptions?: RateLimitOptions;
};

export const createPublicSanctionsRoute = (
  options?: PublicSanctionsRouteOptions,
) => {
  const search =
    options === undefined
      ? publicSanctionsSearch
      : createPublicSanctionsSearchHandler(options);
  return new Elysia({ prefix: "/sanctions" })
    .onRequest(({ set }) => {
      applyResponseCachePolicy({
        cache: search.config.cache,
        response: undefined,
        set,
      });
    })
    .use(
      rateLimit(
        options?.rateLimitOptions ?? createPublicSanctionsRateLimitOptions(),
      ),
    )
    .post("/search", search.handler, {
      body: search.config.body,
      response: search.config.response,
    });
};

export const publicSanctionsRoute = createPublicSanctionsRoute();
