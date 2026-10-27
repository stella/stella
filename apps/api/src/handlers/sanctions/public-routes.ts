import publicSanctionsSearch, {
  createPublicSanctionsSearchHandler,
} from "@/api/handlers/sanctions/search";
import type { PublicSanctionsSearchOptions } from "@/api/handlers/sanctions/search";
import { routes } from "@/api/http/route";
import type { RateLimitOptions } from "@/api/lib/rate-limit/contracts";
import { createPublicSanctionsRateLimitOptions } from "@/api/lib/rate-limit/public-corpus-rate-limits";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";

type PublicSanctionsRouteOptions = PublicSanctionsSearchOptions & {
  rateLimitOptions?: RateLimitOptions;
};

export const createPublicSanctionsRoute = (
  options?: PublicSanctionsRouteOptions,
) =>
  routes(
    {
      "/search": {
        POST:
          options === undefined
            ? publicSanctionsSearch
            : createPublicSanctionsSearchHandler(options),
      },
    },
    {
      prefix: "/sanctions",
      middleware: [
        rateLimit(
          options?.rateLimitOptions ?? createPublicSanctionsRateLimitOptions(),
        ),
      ],
    },
  );

export const publicSanctionsRoute = createPublicSanctionsRoute();
