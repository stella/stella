import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";

import { env } from "@/api/env";
import { getPublicCorpusLimits } from "@/api/lib/limits";
import type { PublicRouteId } from "@/api/public-corpus-route-ids";

export const getPublicCorpusClassPolicy = () => getPublicCorpusLimits(env);

export type PublicCorpusClass = keyof ReturnType<
  typeof getPublicCorpusClassPolicy
>["classes"];

export const PUBLIC_CORPUS_ROUTE_POLICY = {
  "GET /law/statutes": "browse",
  "GET /law/statutes/search": "search",
  "GET /law/statutes/shelf": "browse",
  "GET /law/statutes/facets": "aggregate",
  "GET /law/statutes/by-eli": "browse",
  "POST /law/statutes/resolve": "aggregate",
  "GET /law/statutes/by-slug/:slug": "browse",
  "GET /law/statutes/:documentId": "browse",
  "GET /law/statutes/:documentId/versions": "browse",
  "GET /law/statutes/:documentId/provisions/:anchor/preview": "browse",
  "GET /law/statutes/:documentId/provisions/:anchor/history": "browse",
  "GET /law/sitemap/shards": "sitemap",
  "GET /law/sitemap/statutes/shard": "sitemap",
  "GET /case/coverage": "browse",
  // Adding facets to listing requires updating this classifier and its guard.
  "GET /case/decisions": "browse",
  "GET /case/decisions/facets": "aggregate",
  "GET /case/decisions/status": "browse",
  "GET /case/decisions/latest": "browse",
  "GET /case/decisions/by-slug/:slug": "browse",
  "GET /case/decisions/:decisionId/summary": "browse",
  "GET /case/decisions/:decisionId": "browse",
  "GET /case/decisions/:decisionId/citations": "browse",
  "GET /case/decisions/:decisionId/citations/summary": "browse",
  "GET /case/decisions/:decisionId/citations/leading": "browse",
  "GET /case/decisions/:decisionId/provisions": "browse",
  "GET /case/judges/:judgeId/portrait": "browse",
  "GET /case/provisions/citing-decisions": "aggregate",
  "GET /case/provisions/citation-counts": "aggregate",
  "POST /case/decisions/search": "search",
  "GET /case/sitemap/shards": "sitemap",
  "GET /case/sitemap/decisions/shard": "sitemap",
} as const satisfies Record<PublicRouteId, PublicCorpusClass>;

// Resolve literals first, just as the router does, so `facets` cannot inherit
// the browse policy of `:decisionId`. Patterns are built once, never per request.
const routePolicies = Object.entries(PUBLIC_CORPUS_ROUTE_POLICY)
  .map(([route, routeClass]) => {
    const separator = route.indexOf(" ");
    const method = route.slice(0, separator);
    const path = route.slice(separator + 1);
    return {
      route,
      class: routeClass,
      method,
      dynamic: path.includes(":"),
      pattern: new RegExp(
        `^${STELLA_API_VERSION_PREFIX}${path.replace(/:[^/]+/gu, "[^/]+")}/?$`,
        "u",
      ),
    };
  })
  .toSorted((left, right) => Number(left.dynamic) - Number(right.dynamic));

export const resolvePublicCorpusPolicy = (
  request: Pick<Request, "method" | "url">,
) => {
  const method = request.method === "HEAD" ? "GET" : request.method;
  const { pathname } = new URL(request.url);
  return routePolicies.find(
    (policy) => policy.method === method && policy.pattern.test(pathname),
  );
};
