import type { Middleware } from "@/api/http/route";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";

/**
 * Budgets owned by a few expensive routes, mounted on exactly those routes.
 * One instance per budget, so every route that spends it shares its counters;
 * the shared `/v1` budget skips a route that carries one of these.
 */
const dedicatedBudgets = new WeakSet<Middleware>();

/** Mark a route budget as replacing the shared one for the routes that carry it. */
export const dedicatedBudget = (middleware: Middleware): Middleware => {
  dedicatedBudgets.add(middleware);
  return middleware;
};

/** Whether a route spends a dedicated budget instead of the shared one. */
export const hasDedicatedBudget = (
  middleware: readonly Middleware[],
): boolean => middleware.some((stage) => dedicatedBudgets.has(stage));

/** File uploads into a matter: each stores a document and starts processing. */
export const uploadBudget = dedicatedBudget(
  rateLimit({
    duration: API_RATE_LIMITS.upload.duration,
    max: API_RATE_LIMITS.upload.max,
    budget: { name: "api.upload.address", keyKind: "address" },
    ...createRedisRateLimit({
      failurePolicy: "fail_open_local",
      scope: "upload",
    }),
  }),
);

/**
 * A bilingual layout and a translation run share one budget: each turns a
 * stored file into a new document, and a translation run also spends the
 * organisation's paid character quota with the provider.
 */
export const translateBudget = dedicatedBudget(
  rateLimit({
    duration: API_RATE_LIMITS.translate.duration,
    max: API_RATE_LIMITS.translate.max,
    budget: { name: "api.translate.address", keyKind: "address" },
    ...createRedisRateLimit({
      failurePolicy: "fail_open_local",
      scope: "translate",
    }),
  }),
);

/** The folio collaborative-edit endpoints: the editor calls them on every open. */
export const folioCollabBudget = dedicatedBudget(
  rateLimit({
    duration: API_RATE_LIMITS.folioCollab.duration,
    max: API_RATE_LIMITS.folioCollab.max,
    budget: { name: "api.folio_collab.address", keyKind: "address" },
    ...createRedisRateLimit({
      failurePolicy: "fail_open_local",
      scope: "folio-collab",
    }),
  }),
);

/** Style-set uploads: each stores a template file and parses it. */
export const styleSetUploadBudget = dedicatedBudget(
  rateLimit({
    duration: API_RATE_LIMITS.upload.duration,
    max: API_RATE_LIMITS.upload.max,
    budget: { name: "api.upload.address", keyKind: "address" },
    ...createRedisRateLimit({
      failurePolicy: "fail_open_local",
      scope: "style-set-upload",
    }),
  }),
);
