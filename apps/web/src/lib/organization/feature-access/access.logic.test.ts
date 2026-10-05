import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  notFound,
} from "@tanstack/react-router";
import { describe, expect, test } from "bun:test";

import { callerFeatureEnabled, runForCallerFeature } from "./access.logic";
import { CALLER_FEATURE } from "./surfaces";

for (const feature of Object.values(CALLER_FEATURE)) {
  describe(feature.id, () => {
    test("only an explicit enabled server decision shows the feature", () => {
      expect(callerFeatureEnabled(undefined, feature)).toBe(false);
      expect(callerFeatureEnabled({}, feature)).toBe(false);
      expect(
        callerFeatureEnabled({ [feature.id]: { status: "hidden" } }, feature),
      ).toBe(false);
      expect(
        callerFeatureEnabled({ unrelated: { status: "enabled" } }, feature),
      ).toBe(false);
      expect(
        callerFeatureEnabled({ [feature.id]: { status: "enabled" } }, feature),
      ).toBe(true);
    });
    test("hidden decisions fail admission before any feature prefetch", async () => {
      for (const capabilities of [
        {},
        { [feature.id]: { status: "hidden" as const } },
      ]) {
        let calls = 0;
        const outcome = await runForCallerFeature({
          capabilities,
          feature,
          load: async () => {
            calls += 1;
          },
        });
        expect(outcome.isErr()).toBe(true);
        if (outcome.isErr()) {
          expect(outcome.error.featureId).toBe(feature.id);
        }
        expect(calls).toBe(0);
      }
    });
    test("the router converts denied admission to 404 without prefetch", async () => {
      let calls = 0;
      const rootRoute = createRootRoute();
      const gatedRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: "/gated",
        loader: async () => {
          const admission = await runForCallerFeature({
            capabilities: {},
            feature,
            load: async () => {
              calls += 1;
            },
          });
          if (admission.isErr()) {
            throw notFound();
          }
        },
      });
      const router = createRouter({
        history: createMemoryHistory({ initialEntries: ["/gated"] }),
        routeTree: rootRoute.addChildren([gatedRoute]),
      });
      await router.load();
      expect(router.state.matches.at(-1)?.status).toBe("notFound");
      expect(calls).toBe(0);
    });
    test("enabled routes prefetch once and preserve fetch failures", async () => {
      let calls = 0;
      const options = {
        capabilities: { [feature.id]: { status: "enabled" as const } },
        feature,
      };
      await runForCallerFeature({
        ...options,
        load: async () => {
          calls += 1;
        },
      });
      expect(calls).toBe(1);
      const failure = new TypeError("fixture prefetch failure");
      const outcome = await runForCallerFeature({
        ...options,
        load: async () => {
          throw failure;
        },
      }).then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      expect(outcome).toEqual({ status: "rejected", error: failure });
    });
  });
}
