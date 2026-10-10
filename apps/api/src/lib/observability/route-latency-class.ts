import { isAiRequest } from "@/api/lib/observability/request-context";
import type { RequestClass } from "@/api/lib/observability/request-metrics";

type DeclaredRouteLatencyClass = Extract<RequestClass, "search" | "batch">;

/**
 * Routes whose latency is not held to the CRUD SLO, keyed by
 * `METHOD route` exactly as the lifecycle hooks receive the route (the
 * registered pattern, `/v1` prefix included). `search` covers multi-second
 * corpus search and citation aggregation reads; `batch` covers crawler
 * reads that belong to no latency SLO. `route-latency-class.test.ts` binds
 * every key to a registered route and every search-shaped route to a
 * decision.
 */
export const ROUTE_LATENCY_CLASSES = {
  "GET /v1/case/:country/decisions/resolve": "search",
  "POST /v1/case/decisions/search": "search",
  "GET /v1/case/decisions/:decisionId/citations/summary": "search",
  "GET /v1/case/decisions/:decisionId/citations/leading": "search",
  "GET /v1/case/provisions/citing-decisions": "search",
  "GET /v1/case/provisions/citation-counts": "search",
  "GET /v1/law/statutes/search": "search",
  "GET /v1/law/:country/citations/resolve": "search",
  "POST /v1/legislation/corpus/search": "search",
  "GET /v1/legislation/search": "search",
  "POST /v1/sanctions/search": "search",
  "GET /v1/case/sitemap/shards": "batch",
  "GET /v1/case/sitemap/decisions/shard": "batch",
  "GET /v1/law/sitemap/shards": "batch",
  "GET /v1/law/sitemap/statutes/shard": "batch",
} as const satisfies Record<string, DeclaredRouteLatencyClass>;

const DECLARED_CLASSES = new Map(Object.entries(ROUTE_LATENCY_CLASSES));

type RouteLatencyClassInput = { method: string; route: string };

/** The route's declared class, or `crud` for every undeclared route. */
const routeLatencyClass = ({
  method,
  route,
}: RouteLatencyClassInput): RequestClass =>
  DECLARED_CLASSES.get(`${method} ${route}`) ?? "crud";

/**
 * The class a completed request is measured under. A request that reached
 * a model is `ai` whatever its route declares, so an AI-assisted search
 * still lands in the AI SLO.
 */
export const requestClassAtCompletion = (
  input: RouteLatencyClassInput,
): RequestClass => (isAiRequest() ? "ai" : routeLatencyClass(input));
