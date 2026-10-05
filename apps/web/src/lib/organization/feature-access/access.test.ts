import { QueryClient, skipToken } from "@tanstack/react-query";
import { describe, expect, spyOn, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  organizationSettingsKeys,
  optionalOrganizationSettingsOptions,
} from "@/queries/organization-settings";

import { loadCallerFeature } from "./access";
import { CALLER_FEATURE } from "./surfaces";

const principal = { organizationId: "org-a", userId: "user-a" };

describe.serial("caller feature admission", () => {
  test("the existing settings cache separates users and organizations", () => {
    const key = organizationSettingsKeys.byCaller(principal);
    expect(key).not.toEqual(
      organizationSettingsKeys.byCaller({ ...principal, userId: "user-b" }),
    );
    expect(key).not.toEqual(
      organizationSettingsKeys.byCaller({
        ...principal,
        organizationId: "org-b",
      }),
    );
    expect(
      optionalOrganizationSettingsOptions({ organizationId: null, userId: "" })
        .queryFn,
    ).toBe(skipToken);
  });
  for (const feature of Object.values(CALLER_FEATURE)) {
    test(`${feature.id} refreshes the caller decision before feature reads`, async () => {
      const queryClient = new QueryClient();
      const discovery = {
        declaredFeatureIds: Object.values(CALLER_FEATURE).map(
          (registered) => registered.id,
        ),
        deploymentFeatures: { legalLists: false },
      };
      const read = spyOn(queryClient, "query").mockResolvedValue({
        ...discovery,
        capabilities: Object.fromEntries(
          [
            feature.id,
            ...feature.requires.map((dependency) => dependency.id),
          ].map((id) => [id, { status: "enabled" as const }]),
        ),
      });
      let calls = 0;
      try {
        await loadCallerFeature({
          queryClient,
          principal,
          feature,
          load: async () => {
            calls += 1;
          },
        });
        expect(read).toHaveBeenCalledWith(
          expect.objectContaining({
            queryKey: organizationSettingsKeys.byCaller(principal),
            staleTime: 0,
            retry: false,
          }),
        );
        expect(calls).toBe(1);
        read.mockResolvedValue({ ...discovery, capabilities: {} });
        const outcome = await loadCallerFeature({
          queryClient,
          principal,
          feature,
          load: async () => {
            calls += 1;
          },
        });
        expect(outcome.isErr()).toBe(true);
        if (outcome.isErr()) {
          expect(outcome.error.featureId).toBe(feature.id);
        }
        expect(calls).toBe(1);
        const failure = new TypeError("fixture discovery failure");
        read.mockRejectedValue(failure);
        expect(
          await rejectionOf(
            loadCallerFeature({
              queryClient,
              principal,
              feature,
              load: async () => {
                calls += 1;
              },
            }),
          ),
        ).toBe(failure);
        expect(calls).toBe(1);
      } finally {
        read.mockRestore();
        queryClient.clear();
      }
    });
  }
});
