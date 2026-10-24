import { panic } from "better-result";

import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";

import { env } from "@/api/env";
import { getPublicCorpusLimits } from "@/api/lib/limits";
import type { PublicRouteId } from "@/api/public-corpus-route-ids";

export const getPublicCorpusClassPolicy = () => getPublicCorpusLimits(env);

export type PublicCorpusClass = keyof ReturnType<
  typeof getPublicCorpusClassPolicy
>["classes"];

type PublicCorpusRoutePolicy =
  | { type: "static"; class: PublicCorpusClass }
  | {
      type: "nonempty-query";
      parameter: string;
      defaultClass: PublicCorpusClass;
      nonemptyClass: PublicCorpusClass;
    };

const staticPolicy = (routeClass: PublicCorpusClass) =>
  ({ type: "static", class: routeClass }) as const;

export const PUBLIC_CORPUS_ROUTE_POLICY = {
  "GET /law/statutes": {
    type: "nonempty-query",
    parameter: "query",
    defaultClass: "browse",
    nonemptyClass: "search",
  },
  "GET /law/statutes/search": staticPolicy("search"),
  "GET /law/statutes/shelf": staticPolicy("browse"),
  "GET /law/statutes/facets": staticPolicy("aggregate"),
  "GET /law/statutes/by-eli": staticPolicy("browse"),
  "POST /law/statutes/resolve": staticPolicy("aggregate"),
  "GET /law/statutes/by-slug/:slug": staticPolicy("browse"),
  "GET /law/statutes/:documentId": staticPolicy("browse"),
  "GET /law/statutes/:documentId/versions": staticPolicy("browse"),
  "GET /law/statutes/:documentId/provisions/:anchor/preview":
    staticPolicy("browse"),
  "GET /law/statutes/:documentId/provisions/:anchor/history":
    staticPolicy("browse"),
  "GET /law/sitemap/shards": staticPolicy("sitemap"),
  "GET /law/sitemap/statutes/shard": staticPolicy("sitemap"),
  "GET /case/coverage": staticPolicy("browse"),
  // Adding facets to listing requires updating this classifier and its guard.
  "GET /case/decisions": staticPolicy("browse"),
  "GET /case/decisions/facets": staticPolicy("aggregate"),
  "GET /case/decisions/status": staticPolicy("browse"),
  "GET /case/decisions/latest": staticPolicy("browse"),
  "GET /case/decisions/by-slug/:slug": staticPolicy("browse"),
  "GET /case/decisions/:decisionId": staticPolicy("browse"),
  "GET /case/decisions/:decisionId/citations": staticPolicy("browse"),
  "GET /case/decisions/:decisionId/citations/summary": staticPolicy("browse"),
  "GET /case/decisions/:decisionId/citations/leading": staticPolicy("browse"),
  "GET /case/decisions/:decisionId/provisions": staticPolicy("browse"),
  "GET /case/judges/:judgeId/portrait": staticPolicy("browse"),
  "GET /case/provisions/citing-decisions": staticPolicy("aggregate"),
  "GET /case/provisions/citation-counts": staticPolicy("aggregate"),
  "POST /case/decisions/search": staticPolicy("search"),
  "GET /case/sitemap/shards": staticPolicy("sitemap"),
  "GET /case/sitemap/decisions/shard": staticPolicy("sitemap"),
} as const satisfies Record<PublicRouteId, PublicCorpusRoutePolicy>;

// Resolve literals first, just as the router does, so `facets` cannot inherit
// the browse policy of `:decisionId`. Patterns are built once, never per request.
const routePolicies = Object.entries(PUBLIC_CORPUS_ROUTE_POLICY)
  .map(([route, policy]) => {
    const separator = route.indexOf(" ");
    const method = route.slice(0, separator);
    const path = route.slice(separator + 1);
    return {
      route,
      policy,
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
  const url = new URL(request.url);
  const matched = routePolicies.find(
    (candidate) =>
      candidate.method === method && candidate.pattern.test(url.pathname),
  );
  if (matched === undefined) {
    return undefined;
  }
  switch (matched.policy.type) {
    case "static":
      return { ...matched, class: matched.policy.class };
    case "nonempty-query": {
      const hasNonemptyValue = url.searchParams
        .getAll(matched.policy.parameter)
        .some((value) => value.trim() !== "");
      return {
        ...matched,
        class: hasNonemptyValue
          ? matched.policy.nonemptyClass
          : matched.policy.defaultClass,
      };
    }
    default:
      matched.policy satisfies never;
      return panic("Unhandled public corpus route policy");
  }
};
