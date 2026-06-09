import { describe, expect, test } from "bun:test";

import { KrsValidationError } from "@stll/business-registries/krs";

import type {
  BusinessRegistryHit,
  RegistryHandler,
} from "@/api/lib/business-registries/dispatch";
import { BUSINESS_REGISTRY_DISPATCH } from "@/api/lib/business-registries/dispatch";

import {
  applyLookupFields,
  createDispatchLookupResolver,
  isPlausibleLookupValue,
  type LookupResolver,
  renderLookupHit,
  resolveLookupFields,
} from "./lookup-fields";
import type { FieldMeta } from "./types";

const KRS_ADDRESS = {
  line1: "ul. Stanisława Matyi 8",
  line2: null,
  postalCode: "61-586",
  city: "Poznań",
  region: "wielkopolskie",
  country: "Polska",
  textAddress: "ul. Stanisława Matyi 8, 61-586 Poznań",
};

const KRS_HIT: BusinessRegistryHit = {
  registry: "krs",
  id: "0000592109",
  name: "Żabka Polska sp. z o.o.",
  legalForm: "spółka z ograniczoną odpowiedzialnością",
  address: KRS_ADDRESS,
  registryUrl: "https://example.invalid/krs/0000592109",
};

const krsField: FieldMeta = {
  path: "buyer_krs",
  lookup: { registry: "krs" },
};

const hitResolver =
  (hit: BusinessRegistryHit): LookupResolver =>
  async () => ({ type: "hit", hit });

describe("isPlausibleLookupValue", () => {
  test("accepts a 10-digit KRS number, whitespace-tolerant", () => {
    expect(isPlausibleLookupValue("krs", "0000592109")).toBe(true);
    expect(isPlausibleLookupValue("krs", " 0000 592 109 ")).toBe(true);
  });

  test("rejects short, long, and non-numeric inputs", () => {
    expect(isPlausibleLookupValue("krs", "592109")).toBe(false);
    expect(isPlausibleLookupValue("krs", "00005921090")).toBe(false);
    expect(isPlausibleLookupValue("krs", "KRS0592109")).toBe(false);
  });
});

describe("renderLookupHit", () => {
  test("renders name + text address", () => {
    expect(renderLookupHit(KRS_HIT)).toBe(
      "Żabka Polska sp. z o.o., ul. Stanisława Matyi 8, 61-586 Poznań",
    );
  });

  test("falls back to the city, then to the name alone", () => {
    expect(
      renderLookupHit({
        ...KRS_HIT,
        address: { ...KRS_ADDRESS, textAddress: null },
      }),
    ).toBe("Żabka Polska sp. z o.o., Poznań");
    expect(renderLookupHit({ ...KRS_HIT, address: null })).toBe(
      "Żabka Polska sp. z o.o.",
    );
  });
});

describe("resolveLookupFields", () => {
  test("passes values through when no field has a lookup", async () => {
    const values = { buyer_krs: "not even a number" };
    const result = await resolveLookupFields({
      values,
      fields: [{ path: "buyer_krs" }],
      resolve: hitResolver(KRS_HIT),
    });
    expect(result).toEqual({ ok: true, values });
  });

  test("leaves an absent or empty value for required diagnostics", async () => {
    const result = await resolveLookupFields({
      values: { buyer_krs: "  " },
      fields: [krsField],
      resolve: hitResolver(KRS_HIT),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values["buyer_krs"]).toBe("  ");
    }
  });

  test("rejects a malformed registry number naming the field", async () => {
    const result = await resolveLookupFields({
      values: { buyer_krs: "12345" },
      fields: [krsField],
      resolve: hitResolver(KRS_HIT),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        {
          path: "buyer_krs",
          message: 'Field "buyer_krs": "12345" is not a valid KRS number.',
        },
      ]);
    }
  });

  test("rejects when the registry has no match, naming the field", async () => {
    const result = await resolveLookupFields({
      values: { buyer_krs: "0000592109" },
      fields: [krsField],
      resolve: async () => ({ type: "not-found" }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.at(0)?.message).toBe(
        'Field "buyer_krs": no company found in KRS for "0000592109".',
      );
    }
  });

  test("rejects on an upstream error, surfacing its message", async () => {
    const result = await resolveLookupFields({
      values: { buyer_krs: "0000592109" },
      fields: [krsField],
      resolve: async () => ({ type: "error", message: "KRS API error: 503" }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.at(0)?.message).toBe(
        'Field "buyer_krs": KRS lookup failed: KRS API error: 503',
      );
    }
  });

  test("replaces the number with the deterministic rendering", async () => {
    const result = await resolveLookupFields({
      values: { buyer_krs: "0000592109", other: "kept" },
      fields: [krsField],
      resolve: hitResolver(KRS_HIT),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values["buyer_krs"]).toBe(
        "Żabka Polska sp. z o.o., ul. Stanisława Matyi 8, 61-586 Poznań",
      );
      expect(result.values["other"]).toBe("kept");
    }
  });

  test("replaces a nested value where resolvePath found it", async () => {
    const result = await resolveLookupFields({
      values: { buyer: { krs: "0000592109" } },
      fields: [{ path: "buyer.krs", lookup: { registry: "krs" } }],
      resolve: hitResolver(KRS_HIT),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values["buyer"]).toEqual({
        krs: "Żabka Polska sp. z o.o., ul. Stanisława Matyi 8, 61-586 Poznań",
      });
    }
  });

  test("uses the AI formatter when aiFormat is set", async () => {
    const calls: { instruction: string; fieldPath: string }[] = [];
    const result = await resolveLookupFields({
      values: { buyer_krs: "0000592109" },
      fields: [
        {
          path: "buyer_krs",
          lookup: {
            registry: "krs",
            aiFormat: "[name], with its seat in [seat], KRS [number]",
          },
        },
      ],
      resolve: hitResolver(KRS_HIT),
      formatWithAi: async ({ instruction, fieldPath }) => {
        calls.push({ instruction, fieldPath });
        return "Żabka Polska sp. z o.o., with its seat in Poznań, KRS 0000592109";
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values["buyer_krs"]).toBe(
        "Żabka Polska sp. z o.o., with its seat in Poznań, KRS 0000592109",
      );
    }
    expect(calls).toEqual([
      {
        instruction: "[name], with its seat in [seat], KRS [number]",
        fieldPath: "buyer_krs",
      },
    ]);
  });

  test("falls back to the deterministic rendering when AI declines", async () => {
    const result = await resolveLookupFields({
      values: { buyer_krs: "0000592109" },
      fields: [
        { path: "buyer_krs", lookup: { registry: "krs", aiFormat: "format" } },
      ],
      resolve: hitResolver(KRS_HIT),
      formatWithAi: async () => undefined,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values["buyer_krs"]).toBe(
        "Żabka Polska sp. z o.o., ul. Stanisława Matyi 8, 61-586 Poznań",
      );
    }
  });

  test("does not call the AI formatter without an aiFormat instruction", async () => {
    let called = false;
    await resolveLookupFields({
      values: { buyer_krs: "0000592109" },
      fields: [krsField],
      resolve: hitResolver(KRS_HIT),
      formatWithAi: async () => {
        called = true;
        return "never";
      },
    });
    expect(called).toBe(false);
  });
});

describe("createDispatchLookupResolver — mocked dispatch", () => {
  const stubDispatch = (
    override: Partial<RegistryHandler>,
  ): Record<"krs", RegistryHandler> => ({
    krs: { ...BUSINESS_REGISTRY_DISPATCH.krs, ...override },
  });

  test("returns the hit from the registry handler's lookup", async () => {
    const resolver = createDispatchLookupResolver(
      stubDispatch({ lookup: async () => KRS_HIT }),
    );
    const outcome = await resolver({ registry: "krs", query: "0000592109" });
    expect(outcome).toEqual({ type: "hit", hit: KRS_HIT });
  });

  test("maps a null hit to not-found", async () => {
    const resolver = createDispatchLookupResolver(
      stubDispatch({ lookup: async () => null }),
    );
    const outcome = await resolver({ registry: "krs", query: "0000592109" });
    expect(outcome).toEqual({ type: "not-found" });
  });

  test("maps adapter validation errors to an error outcome", async () => {
    const resolver = createDispatchLookupResolver(
      stubDispatch({
        lookup: () => {
          throw new KrsValidationError("KRS number must be 10 digits");
        },
      }),
    );
    const outcome = await resolver({ registry: "krs", query: "0000592109" });
    expect(outcome).toEqual({
      type: "error",
      message: "KRS number must be 10 digits",
    });
  });
});

describe("applyLookupFields — fill flow over a mocked dispatch", () => {
  test("rewrites the submitted KRS number in place and returns null", async () => {
    const values: Record<string, unknown> = { buyer_krs: "0000592109" };
    const error = await applyLookupFields(
      values,
      { fields: [krsField] },
      {
        resolve: createDispatchLookupResolver({
          krs: {
            ...BUSINESS_REGISTRY_DISPATCH.krs,
            lookup: async () => KRS_HIT,
          },
        }),
      },
    );
    expect(error).toBeNull();
    expect(values["buyer_krs"]).toBe(
      "Żabka Polska sp. z o.o., ul. Stanisława Matyi 8, 61-586 Poznań",
    );
  });

  test("returns the combined message when a lookup fails", async () => {
    const values: Record<string, unknown> = { buyer_krs: "0000592109" };
    const error = await applyLookupFields(
      values,
      { fields: [krsField] },
      {
        resolve: createDispatchLookupResolver({
          krs: { ...BUSINESS_REGISTRY_DISPATCH.krs, lookup: async () => null },
        }),
      },
    );
    expect(error).toBe(
      'Field "buyer_krs": no company found in KRS for "0000592109".',
    );
    expect(values["buyer_krs"]).toBe("0000592109");
  });

  test("is a no-op without a manifest", async () => {
    const values: Record<string, unknown> = { buyer_krs: "0000592109" };
    const error = await applyLookupFields(values, null, {
      resolve: hitResolver(KRS_HIT),
    });
    expect(error).toBeNull();
    expect(values["buyer_krs"]).toBe("0000592109");
  });
});
