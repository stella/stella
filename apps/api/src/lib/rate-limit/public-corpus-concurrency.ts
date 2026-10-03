import { panic } from "better-result";
import { Elysia } from "elysia";

import { env } from "@/api/env";
import { logger } from "@/api/lib/observability/logger";
import { emitPublicCorpusAdmissionMetric } from "@/api/lib/observability/request-metrics";
import { DEFAULT_RATE_LIMIT_ERROR_RESPONSE } from "@/api/lib/rate-limit/rate-limit";
import {
  getPublicCorpusClassPolicy,
  type PublicCorpusClass,
  resolvePublicCorpusPolicy,
} from "@/api/public-corpus-policy";

type PublicCorpusConcurrencyOptions = {
  observe?: typeof emitPublicCorpusAdmissionMetric;
};

// One instance belongs to the process-wide HTTP composition, not to a route
// or address. Admission is synchronous and never queues behind busy work.
export const publicCorpusConcurrencyLimit = ({
  observe = emitPublicCorpusAdmissionMetric,
}: PublicCorpusConcurrencyOptions = {}) => {
  const policyLimits = getPublicCorpusClassPolicy();
  const active = new Map(
    Object.entries({
      search: { count: 0 },
      aggregate: { count: 0 },
      sitemap: { count: 0 },
    } satisfies Record<
      Exclude<PublicCorpusClass, "browse">,
      { count: number }
    >),
  );
  let totalActive = 0;
  const leases = new WeakMap<Request, () => void>();
  const release = (request: Request): void => {
    const lease = leases.get(request);
    if (lease === undefined) {
      return;
    }
    leases.delete(request);
    lease();
  };

  const middleware = (scope: "statute" | "shared") =>
    new Elysia()
      .onBeforeHandle({ as: "scoped" }, ({ request, set, status }) => {
        if (env.E2E_DISABLE_AUTH_RATE_LIMIT) {
          return undefined;
        }
        const policy = resolvePublicCorpusPolicy(request);
        if (policy === undefined || policy.class === "browse") {
          return undefined;
        }
        if (
          (policy.route === "GET /law/statutes/search") !==
          (scope === "statute")
        ) {
          return undefined;
        }
        const routeClass = policy.class;
        const classActive = active.get(routeClass);
        if (classActive === undefined)
          {panic("Missing public corpus concurrency class");}
        const capacity =
          routeClass === "sitemap"
            ? policyLimits.totalConcurrency
            : policyLimits.classes[routeClass].concurrency;
        if (
          request.signal.aborted ||
          classActive.count >= capacity ||
          totalActive >= policyLimits.totalConcurrency
        ) {
          observe({ class: routeClass, outcome: "refused" });
          logger.warn("api.public_corpus.admission_refused", {
            class: routeClass,
            capacity,
            totalCapacity: policyLimits.totalConcurrency,
          });
          set.headers["Retry-After"] = "1";
          return status(429, DEFAULT_RATE_LIMIT_ERROR_RESPONSE);
        }
        classActive.count += 1;
        totalActive += 1;
        leases.set(request, () => {
          classActive.count -= 1;
          totalActive -= 1;
        });
        observe({ class: routeClass, outcome: "acquired" });
        return undefined;
      })
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
      });
  return { shared: middleware("shared"), statute: middleware("statute") };
};
