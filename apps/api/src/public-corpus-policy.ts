import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";

import { env } from "@/api/env";
import { getPublicCorpusLimits } from "@/api/lib/limits";

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
} as const satisfies Record<string, PublicCorpusClass>;

const ROUTE_POLICY: ReadonlyMap<string, PublicCorpusClass> = new Map(
  Object.entries(PUBLIC_CORPUS_ROUTE_POLICY),
);

/** A mounted route as the policy table names it: its method and full path pattern. */
type MountedRoute = { readonly method: string; readonly path: string };

/**
 * The public corpus class of a mounted route, or `undefined` for every other
 * route. The table names routes the way the router matched them (method and
 * pattern, without the version prefix), so a literal segment such as `facets`
 * can never fall into the class of `:decisionId`; a HEAD request is served by
 * its GET route. The census in `public-corpus-policy.test.ts` ties the table
 * to the mounted public corpus routes in both directions.
 */
export const publicCorpusClassOf = (
  route: MountedRoute | undefined,
): PublicCorpusClass | undefined => {
  if (
    route === undefined ||
    !route.path.startsWith(STELLA_API_VERSION_PREFIX)
  ) {
    return undefined;
  }
  const method = route.method === "HEAD" ? "GET" : route.method;
  return ROUTE_POLICY.get(
    `${method} ${route.path.slice(STELLA_API_VERSION_PREFIX.length)}`,
  );
};
