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

const availability = (
  capabilities: NonNullable<
    Parameters<typeof callerFeatureEnabled>[0]
  >["capabilities"],
) => ({
  capabilities,
  declaredFeatureIds: Object.values(CALLER_FEATURE).map(
    (feature) => feature.id,
  ),
  deploymentFeatures: { legalLists: false },
});

for (const feature of Object.values(CALLER_FEATURE)) {
  describe(feature.id, () => {
    test("only an explicit enabled server decision shows the feature", () => {
      expect(callerFeatureEnabled(undefined, feature)).toBe(false);
      expect(callerFeatureEnabled(availability({}), feature)).toBe(false);
      expect(
        callerFeatureEnabled(
          availability({ [feature.id]: { status: "hidden" } }),
          feature,
        ),
      ).toBe(false);
      expect(
        callerFeatureEnabled(
          availability({ unrelated: { status: "enabled" } }),
          feature,
        ),
      ).toBe(false);
      expect(
        callerFeatureEnabled(
          availability({ [feature.id]: { status: "enabled" } }),
          feature,
        ),
      ).toBe(feature.requires.length === 0);
    });
    test("hidden decisions fail admission before any feature prefetch", async () => {
      for (const capabilities of [
        {},
        { [feature.id]: { status: "hidden" as const } },
      ]) {
        let calls = 0;
        const outcome = await runForCallerFeature({
          availability: availability(capabilities),
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
            availability: availability({}),
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
        availability: availability(
          Object.fromEntries(
            [
              feature.id,
              ...feature.requires.map((dependency) => dependency.id),
            ].map((id) => [id, { status: "enabled" as const }]),
          ),
        ),
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

test("verification needs both capabilities for UI and prefetch admission", async () => {
  const feature = CALLER_FEATURE.verification;
  for (const verificationEnabled of [false, true]) {
    for (const legalListsEnabled of [false, true]) {
      const capabilities = {
        [feature.id]: { status: verificationEnabled ? "enabled" : "hidden" },
        [CALLER_FEATURE.legalLists.id]: {
          status: legalListsEnabled ? "enabled" : "hidden",
        },
      } as const;
      const enabled = verificationEnabled && legalListsEnabled;
      expect(callerFeatureEnabled(availability(capabilities), feature)).toBe(
        enabled,
      );
      let calls = 0;
      const admission = await runForCallerFeature({
        availability: availability(capabilities),
        feature,
        load: async () => {
          calls += 1;
        },
      });
      expect(admission.isOk()).toBe(enabled);
      expect(calls).toBe(enabled ? 1 : 0);
    }
  }
});

test("undeclared Legal Lists needs deployment and an enabled verification caller", async () => {
  for (const deploymentEnabled of [false, true]) {
    for (const status of [undefined, "hidden", "enabled"] as const) {
      const state = {
        declaredFeatureIds: [CALLER_FEATURE.verification.id],
        capabilities:
          status === undefined
            ? { unrelated: { status: "enabled" as const } }
            : { [CALLER_FEATURE.verification.id]: { status } },
        deploymentFeatures: { legalLists: deploymentEnabled },
      };
      const enabled = deploymentEnabled && status === "enabled";
      for (const feature of Object.values(CALLER_FEATURE)) {
        expect(callerFeatureEnabled(state, feature)).toBe(enabled);
        let calls = 0;
        const admission = await runForCallerFeature({
          availability: state,
          feature,
          load: async () => {
            calls += 1;
          },
        });
        expect(admission.isOk()).toBe(enabled);
        expect(calls).toBe(enabled ? 1 : 0);
      }
    }
  }
});

test("declared features require an explicit decision even when deployment is enabled", () => {
  const state = {
    declaredFeatureIds: [CALLER_FEATURE.legalLists.id],
    capabilities: {},
    deploymentFeatures: { legalLists: true },
  };
  expect(callerFeatureEnabled(state, CALLER_FEATURE.legalLists)).toBe(false);
  expect(
    callerFeatureEnabled(
      {
        ...state,
        capabilities: { [CALLER_FEATURE.legalLists.id]: { status: "hidden" } },
      },
      CALLER_FEATURE.legalLists,
    ),
  ).toBe(false);
  expect(
    callerFeatureEnabled(
      {
        ...state,
        capabilities: { [CALLER_FEATURE.legalLists.id]: { status: "enabled" } },
      },
      CALLER_FEATURE.legalLists,
    ),
  ).toBe(true);
  expect(
    callerFeatureEnabled(
      {
        ...state,
        declaredFeatureIds: [],
        deploymentFeatures: { legalLists: false },
        capabilities: { [CALLER_FEATURE.legalLists.id]: { status: "enabled" } },
      },
      CALLER_FEATURE.legalLists,
    ),
  ).toBe(false);
});

test("declared Legal Lists decisions do not require verification", () => {
  for (const deploymentEnabled of [false, true]) {
    for (const enabled of [false, true]) {
      const status = enabled ? "enabled" : "hidden";
      expect(
        callerFeatureEnabled(
          {
            declaredFeatureIds: [CALLER_FEATURE.legalLists.id],
            deploymentFeatures: { legalLists: deploymentEnabled },
            capabilities: { [CALLER_FEATURE.legalLists.id]: { status } },
          },
          CALLER_FEATURE.legalLists,
        ),
      ).toBe(enabled);
    }
  }
});
