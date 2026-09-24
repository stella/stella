import { describe, expect, test } from "bun:test";

import {
  publishResolvedRouteIds,
  subscribeResolvedRouteIds,
} from "@/lib/resolved-route-ids";

describe("resolved route ids", () => {
  test("a listener that subscribes after a resolution sees it, then later ones", () => {
    publishResolvedRouteIds(new Set(["/law"]));
    const seen: string[][] = [];
    const unsubscribe = subscribeResolvedRouteIds((ids) => {
      seen.push([...ids]);
    });
    publishResolvedRouteIds(new Set(["/law/cases"]));
    unsubscribe();
    publishResolvedRouteIds(new Set(["/"]));

    expect(seen).toEqual([["/law"], ["/law/cases"]]);
  });
});
