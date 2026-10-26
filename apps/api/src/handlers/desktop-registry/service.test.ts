import { expect, test } from "bun:test";

import { searchDesktopRegistry } from "@/api/handlers/desktop-registry/service";
import { toSafeId } from "@/api/lib/branded-types";
import { BUSINESS_REGISTRY_DISPATCH } from "@/api/lib/business-registries/dispatch";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

test("maps unavailable web-backed name search to a retryable upstream error", async () => {
  const result = await searchDesktopRegistry(
    {
      organizationId: toSafeId<"organization">("fixture-org"),
      userId: toSafeId<"user">("fixture-user"),
      scopedDb: asTestRaw(() => {
        throw new Error(
          "the unavailable result must return before format reads",
        );
      }),
      testDependencies: {
        getOrganizationRegistryHandler: async () =>
          BUSINESS_REGISTRY_DISPATCH.krs,
      },
    },
    { registry: "krs", query: "Fikcyjna Firma" },
  );

  expect(result.isErr()).toBe(true);
  if (result.isOk()) {
    throw new TypeError("expected an unavailable error");
  }
  expect(result.error).toMatchObject({
    status: 502,
    code: "upstream_unavailable",
    retryable: true,
  });
});
