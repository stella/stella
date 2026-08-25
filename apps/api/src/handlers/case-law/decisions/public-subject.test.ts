import { describe, expect, test } from "bun:test";

import {
  isSubjectGatedHandler,
  subjectGatedHandlers,
} from "@/api/handlers/case-law/decisions/public-subject";
import { publicCaseLawRoute } from "@/api/handlers/case-law/public-routes";

/**
 * Routes that answer without naming one decision, declared rather than
 * inferred.
 *
 * The census reads this list as the exception and treats the gate as the
 * rule, because the other way round cannot be safe: a heuristic over the
 * path ("does it contain `:decisionId`?") silently excludes a route spelled
 * `/decisions/:id/history` or `/decisions/lookup/:slug`, and an ungated
 * handler mounted there would pass every check. Adding a route therefore
 * either goes through the gate factory or is written down here, where it is
 * reviewed as the deliberate act it is.
 */
const SUBJECT_FREE_ROUTES = [
  "GET /case/decisions",
  "GET /case/decisions/facets",
  "GET /case/provisions/citing-decisions",
  "GET /case/sitemap/decisions/shard",
  "GET /case/sitemap/shards",
  "POST /case/decisions/search",
] as const;

const routeId = (route: { method: string; path: string }) =>
  `${route.method} ${route.path}`;

describe("public decision routes are gated by construction", () => {
  const routes = publicCaseLawRoute.routes
    .map((route) => ({
      handler: route.handler,
      method: route.method,
      path: route.path,
    }))
    // Elysia mounts internal entries (HEAD, error pages) that carry no
    // handler of ours; the census is about the routes this slice declares.
    .filter((route) => typeof route.handler === "function");

  const subjectFree = new Set<string>(SUBJECT_FREE_ROUTES);

  test("every route that is not declared subject-free is gated", () => {
    const ungated = routes
      .filter((route) => !subjectFree.has(routeId(route)))
      .filter((route) => !isSubjectGatedHandler(route.handler))
      .map(routeId);
    expect(ungated).toEqual([]);
  });

  test("every factory-made handler is mounted", () => {
    const mounted = new Set<unknown>(routes.map((route) => route.handler));
    const orphaned = [...subjectGatedHandlers()].filter(
      (handler) => !mounted.has(handler),
    );
    expect(orphaned).toEqual([]);
  });

  test("no route declared subject-free carries the gate", () => {
    const misapplied = routes
      .filter((route) => subjectFree.has(routeId(route)))
      .filter((route) => isSubjectGatedHandler(route.handler))
      .map(routeId);
    expect(misapplied).toEqual([]);
  });

  test("every declared subject-free route is mounted", () => {
    // Keeps the exception list from outliving its routes: a stale entry
    // would silently excuse a future route that reuses the same path.
    const mounted = new Set(routes.map(routeId));
    const stale = [...SUBJECT_FREE_ROUTES].filter((id) => !mounted.has(id));
    expect(stale).toEqual([]);
  });

  test("the census covers the routes this slice is known to expose", () => {
    const gated = routes
      .filter((route) => isSubjectGatedHandler(route.handler))
      .map(routeId)
      .sort();
    expect(gated).toEqual([
      "GET /case/decisions/:decisionId",
      "GET /case/decisions/:decisionId/citations",
      "GET /case/decisions/:decisionId/citations/leading",
      "GET /case/decisions/:decisionId/citations/summary",
      "GET /case/decisions/:decisionId/provisions",
      "GET /case/decisions/by-slug/:slug",
    ]);
  });
});
