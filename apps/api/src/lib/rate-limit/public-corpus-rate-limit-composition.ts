import type { Middleware } from "@/api/http/route";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import type { RateLimitOptions } from "@/api/lib/rate-limit/contracts";
import { hasDedicatedBudget } from "@/api/lib/rate-limit/dedicated-budgets";
import { publicCorpusConcurrencyLimit } from "@/api/lib/rate-limit/public-corpus-concurrency";
import {
  createPublicCorpusAddressRateLimitOptions,
  createPublicCorpusGlobalRateLimitOptions,
} from "@/api/lib/rate-limit/public-corpus-rate-limits";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";
import {
  createSearchCrawlerVerifier,
  isVerifiedSearchCrawler,
} from "@/api/lib/rate-limit/verified-search-crawler";
import { publicCorpusClassOf } from "@/api/public-corpus-policy";

type PublicCorpusRateLimitCompositionOptions = {
  skipShared?: RateLimitOptions["skip"];
  createRedisBinding?: typeof createRedisRateLimit;
  concurrency?: Parameters<typeof publicCorpusConcurrencyLimit>[0];
  verifyCrawlerAddress?: ReturnType<typeof createSearchCrawlerVerifier>;
};

// Keep the shared-quota exclusion and the class budgets under one owner:
// installing only either half leaves public corpus work unbudgeted or charged
// twice. Every route the policy table classifies alike shares its buckets.
export const createPublicCorpusRateLimitComposition = ({
  skipShared = () => false,
  createRedisBinding = createRedisRateLimit,
  concurrency,
  verifyCrawlerAddress = createSearchCrawlerVerifier(),
}: PublicCorpusRateLimitCompositionOptions = {}): readonly Middleware[] => {
  const crawlers = new WeakSet<Request>();
  const verifyCrawler: Middleware = async (ctx, inner) => {
    const routeClass = publicCorpusClassOf(ctx.routeEntry);
    if (
      (routeClass === "browse" || routeClass === "sitemap") &&
      (ctx.request.method === "GET" || ctx.request.method === "HEAD") &&
      (await isVerifiedSearchCrawler({
        request: ctx.request,
        server: ctx.server,
        verifyAddress: verifyCrawlerAddress,
      }))
    ) {
      crawlers.add(ctx.request);
    }
    return await inner();
  };
  const sitemapAddress = createPublicCorpusAddressRateLimitOptions(
    "sitemap",
    createRedisBinding,
  );
  return [
    verifyCrawler,
    rateLimit({
      duration: API_RATE_LIMITS.api.duration,
      max: API_RATE_LIMITS.api.max,
      budget: { name: "api.address", keyKind: "address" },
      ...createRedisBinding({
        failurePolicy: "fail_open_local",
        scope: "api",
      }),
      // A route with a dedicated budget, or a public corpus class with its own
      // buckets, is charged there instead.
      skip: async (request, entry) => {
        const routeClass = publicCorpusClassOf(entry);
        return (
          routeClass === "search" ||
          routeClass === "aggregate" ||
          routeClass === "sitemap" ||
          (routeClass === "browse" && crawlers.has(request)) ||
          (entry !== undefined && hasDedicatedBudget(entry.middleware)) ||
          (await skipShared(request, entry))
        );
      },
    }),
    rateLimit(
      createPublicCorpusAddressRateLimitOptions(
        "aggregate",
        createRedisBinding,
      ),
    ),
    rateLimit({
      ...sitemapAddress,
      skip: (request, entry) =>
        crawlers.has(request) || sitemapAddress.skip(request, entry),
    }),
    rateLimit(
      createPublicCorpusAddressRateLimitOptions("search", createRedisBinding),
    ),
    publicCorpusConcurrencyLimit(concurrency),
    rateLimit(
      createPublicCorpusGlobalRateLimitOptions("search", createRedisBinding),
    ),
    rateLimit(
      createPublicCorpusGlobalRateLimitOptions("aggregate", createRedisBinding),
    ),
    rateLimit(
      createPublicCorpusGlobalRateLimitOptions("sitemap", createRedisBinding),
    ),
  ];
};
