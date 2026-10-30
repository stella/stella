import { toResponse } from "@/api/http/respond";
import type { Middleware } from "@/api/http/route";
import { status } from "@/api/http/status";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import type { RateLimitOptions } from "@/api/lib/rate-limit/contracts";
import { hasDedicatedBudget } from "@/api/lib/rate-limit/dedicated-budgets";
import { publicCorpusConcurrencyLimit } from "@/api/lib/rate-limit/public-corpus-concurrency";
import {
  createPublicCorpusAddressRateLimitOptions,
  createPublicCorpusGlobalRateLimitOptions,
} from "@/api/lib/rate-limit/public-corpus-rate-limits";
import {
  asRouteBudget,
  DEFAULT_RATE_LIMIT_ERROR_RESPONSE,
  rateLimit,
} from "@/api/lib/rate-limit/rate-limit";
import { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";
import {
  CRAWLER_VERIFICATION_CAPACITY_REFUSED,
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

const MAX_CRAWLER_VERIFICATION_WAITERS_PER_ADDRESS = 32;

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
  const crawlerVerificationWaiters = new Map<string, number>();
  const boundedVerifyCrawlerAddress = async (address: string) => {
    const waiters = crawlerVerificationWaiters.get(address) ?? 0;
    if (waiters >= MAX_CRAWLER_VERIFICATION_WAITERS_PER_ADDRESS) {
      return CRAWLER_VERIFICATION_CAPACITY_REFUSED;
    }
    crawlerVerificationWaiters.set(address, waiters + 1);
    try {
      return await verifyCrawlerAddress(address);
    } finally {
      const remaining = (crawlerVerificationWaiters.get(address) ?? 1) - 1;
      if (remaining === 0) {
        crawlerVerificationWaiters.delete(address);
      } else {
        crawlerVerificationWaiters.set(address, remaining);
      }
    }
  };
  const verifyCrawler = asRouteBudget(async (ctx, inner) => {
    const routeClass = publicCorpusClassOf(ctx.routeEntry);
    const crawlerIdentity =
      (routeClass === "browse" || routeClass === "sitemap") &&
      (ctx.request.method === "GET" || ctx.request.method === "HEAD") &&
      (await isVerifiedSearchCrawler({
        request: ctx.request,
        server: ctx.server,
        verifyAddress: boundedVerifyCrawlerAddress,
      }));
    if (crawlerIdentity === CRAWLER_VERIFICATION_CAPACITY_REFUSED) {
      ctx.set.headers["Retry-After"] = "1";
      return toResponse(
        status(503, DEFAULT_RATE_LIMIT_ERROR_RESPONSE),
        ctx.set,
      );
    }
    if (crawlerIdentity) {
      crawlers.add(ctx.request);
    }
    return await inner();
  });
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
