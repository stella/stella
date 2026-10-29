import { Result } from "better-result";
import { expect, test } from "bun:test";

import { readFailureBrand } from "@stll/errors";

import { searchDesktopRegistry } from "@/api/handlers/desktop-registry/service";
import { toSafeId } from "@/api/lib/branded-types";
import { BUSINESS_REGISTRY_DISPATCH } from "@/api/lib/business-registries/dispatch";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

test("returns verified KRS candidates through desktop web name search", async () => {
  const result = await searchDesktopRegistry(
    {
      organizationId: toSafeId<"organization">("fixture-org"),
      userId: toSafeId<"user">("fixture-user"),
      scopedDb: asTestRaw(() => {
        throw new Error("format reads are injected in this test");
      }),
      testDependencies: {
        getOrganizationRegistryHandler: async () => ({
          ...BUSINESS_REGISTRY_DISPATCH.krs,
          lookup: async (id) => ({
            registry: "krs",
            id,
            name: "ORLEN SPÓŁKA AKCYJNA",
            legalForm: null,
            address: null,
            registryUrl: `https://example.invalid/krs/${id}`,
          }),
        }),
        loadWebSearch: async () =>
          Result.ok({
            provider: {
              name: "tavily",
              search: async () => ({
                results: [
                  {
                    id: "edge-result",
                    title: "ORLEN KRS 0000028860",
                    snippet: "Official company record",
                    url: "https://example.invalid/result",
                    source: "fixture",
                  },
                ],
              }),
            },
            observer: () => undefined,
          }),
        loadFormats: async () => ({
          formats: [],
          defaultFormatId: null,
          defaultFormatSource: null,
          defaultFormat: null,
        }),
      },
    },
    { registry: "krs", query: "orlen" },
  );

  expect(result.isOk()).toBe(true);
  if (result.isErr()) {
    throw result.error;
  }
  expect(result.value.results).toEqual([
    expect.objectContaining({ id: "0000028860", name: "ORLEN SPÓŁKA AKCYJNA" }),
  ]);
});

test("classifies web search configuration failures", async () => {
  const result = await searchDesktopRegistry(
    {
      organizationId: toSafeId<"organization">("fixture-org"),
      userId: toSafeId<"user">("fixture-user"),
      scopedDb: asTestRaw(() => {
        throw new Error("configuration read failed");
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
    throw new TypeError("expected a web search configuration failure");
  }
  expect(result.error).toMatchObject({
    status: 500,
    message: "Could not load web search configuration",
  });
  expect(readFailureBrand(result.error)).toEqual({
    reason: "unobserved_5xx",
    source: "instance",
  });
});
