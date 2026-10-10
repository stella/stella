import { Elysia } from "elysia";

import { env } from "@/api/env";
import {
  type RateLimitClientAddressOptions,
  resolveRateLimitClientAddress,
} from "@/api/lib/client-ip";
import { logger } from "@/api/lib/observability/logger";
import { emitPublicCorpusAdmissionMetric } from "@/api/lib/observability/request-metrics";
import {
  type AdmissionClass,
  type AdmissionLease,
  createPublicCorpusAdmission,
} from "@/api/lib/rate-limit/public-corpus-admission";
import { DEFAULT_RATE_LIMIT_ERROR_RESPONSE } from "@/api/lib/rate-limit/rate-limit";
import {
  getPublicCorpusClassPolicy,
  resolvePublicCorpusPolicy,
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
}: PublicCorpusConcurrencyOptions = {}) => {
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
  const leases = new WeakMap<Request, AdmissionLease>();
  const release = (request: Request): void => {
    const lease = leases.get(request);
    if (lease === undefined) {
      return;
    }
    leases.delete(request);
    lease();
  };

  return (
    new Elysia()
      .onBeforeHandle(
        { as: "scoped" },
        async ({ request, server, set, status }) => {
          if (env.E2E_DISABLE_AUTH_RATE_LIMIT) {
            return undefined;
          }
          const policy = resolvePublicCorpusPolicy(request);
          if (policy === undefined || policy.class === "browse") {
            return undefined;
          }
          const routeClass = policy.class;
          const lease = await admission.acquire({
            routeClass,
            client: clientOf(request, server),
            waitMs: waitMsOf(routeClass),
            signal: request.signal,
          });
          if (lease === null) {
            observe({ class: routeClass, outcome: "refused" });
            logger.warn("api.public_corpus.admission_refused", {
              class: routeClass,
              capacity: capacityOf(routeClass),
              totalCapacity: policyLimits.totalConcurrency,
            });
            set.headers["Retry-After"] = "1";
            return status(429, DEFAULT_RATE_LIMIT_ERROR_RESPONSE);
          }
          leases.set(request, lease);
          observe({ class: routeClass, outcome: "acquired" });
          return undefined;
        },
      )
      // Disconnect does not cancel these handlers' database/index work. Keep
      // its lease until that work settles, including after abort or timeout.
      .onError({ as: "scoped" }, ({ request }) => {
        release(request);
      })
      .mapResponse({ as: "scoped" }, ({ request }) => {
        release(request);
      })
      .onAfterResponse({ as: "scoped" }, ({ request }) => {
        release(request);
      })
  );
};
