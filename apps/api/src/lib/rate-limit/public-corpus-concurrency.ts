import { env } from "@/api/env";
import { toResponse } from "@/api/http/respond";
import type { Middleware } from "@/api/http/route";
import { status } from "@/api/http/status";
import {
  type RateLimitClientAddressOptions,
  resolveRateLimitClientAddress,
} from "@/api/lib/client-ip";
import { logger } from "@/api/lib/observability/logger";
import { emitPublicCorpusAdmissionMetric } from "@/api/lib/observability/request-metrics";
import {
  type AdmissionClass,
  createPublicCorpusAdmission,
} from "@/api/lib/rate-limit/public-corpus-admission";
import {
  asRouteBudget,
  DEFAULT_RATE_LIMIT_ERROR_RESPONSE,
} from "@/api/lib/rate-limit/rate-limit";
import {
  getPublicCorpusClassPolicy,
  publicCorpusClassOf,
} from "@/api/public-corpus-policy";

type PublicCorpusConcurrencyOptions = {
  observe?: (event: {
    class: AdmissionClass;
    outcome: "acquired" | "refused";
  }) => void;
  waitMsOf?: (routeClass: AdmissionClass) => number;
  clientOf?: (
    request: Request,
    server: RateLimitClientAddressOptions["server"],
  ) => string;
};

// A page fires its search and facets at once; a short wait lets the second
// follow the first instead of failing. Crawled sitemaps have no user waiting.
const ADMISSION_WAIT_MS = {
  search: 2000,
  aggregate: 2000,
  sitemap: 500,
} as const satisfies Record<AdmissionClass, number>;

const MAX_ADMISSION_WAITERS = 64;

// Requests without a resolvable address share one client key, so together
// they hold at most one slot per class.
const UNRESOLVED_CLIENT = "unresolved";

// One instance belongs to the process-wide HTTP composition, not to a route
// or address. Waiting requests hold no slot and no database connection.
export const publicCorpusConcurrencyLimit = ({
  observe = (event) => {
    if (event.outcome === "refused") {
      emitPublicCorpusAdmissionMetric({
        class: event.class,
        outcome: event.outcome,
      });
    }
  },
  waitMsOf = (routeClass) => ADMISSION_WAIT_MS[routeClass],
  clientOf = (request, server) =>
    resolveRateLimitClientAddress({ request, server }) ?? UNRESOLVED_CLIENT,
}: PublicCorpusConcurrencyOptions = {}): Middleware => {
  const policyLimits = getPublicCorpusClassPolicy();
  const capacityOf = (routeClass: AdmissionClass) =>
    routeClass === "sitemap"
      ? policyLimits.totalConcurrency
      : policyLimits.classes[routeClass].concurrency;
  const admission = createPublicCorpusAdmission({
    capacityOf,
    totalCapacity: policyLimits.totalConcurrency,
    maxWaiters: MAX_ADMISSION_WAITERS,
  });
  // It waits for or refuses a concurrency slot and decides nothing else.
  return asRouteBudget(async (ctx, inner) => {
    if (env.E2E_DISABLE_AUTH_RATE_LIMIT) {
      return await inner();
    }
    const routeClass = publicCorpusClassOf(ctx.routeEntry);
    if (routeClass === undefined || routeClass === "browse") {
      return await inner();
    }
    const release = await admission.acquire({
      routeClass,
      client: clientOf(ctx.request, ctx.server),
      waitMs: waitMsOf(routeClass),
      signal: ctx.request.signal,
    });
    if (release === null) {
      observe({ class: routeClass, outcome: "refused" });
      logger.warn("api.public_corpus.admission_refused", {
        class: routeClass,
        capacity: capacityOf(routeClass),
        totalCapacity: policyLimits.totalConcurrency,
      });
      ctx.set.headers["Retry-After"] = "1";
      return toResponse(
        status(503, DEFAULT_RATE_LIMIT_ERROR_RESPONSE),
        ctx.set,
      );
    }
    observe({ class: routeClass, outcome: "acquired" });
    // Disconnect does not cancel the handler's database or index work, so the
    // slot is held until that work settles, abort and timeout included.
    try {
      return await inner();
    } finally {
      release();
    }
  });
};
