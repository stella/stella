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
  lookupValueFromRendered,
  parseLookupMarkdown,
  renderLookupHit,
  renderLookupOutput,
  resolveLookupFields,
  stripLookupMarkdown,
} from "./lookup-fields";
import { patchXmlPart } from "./rich-patch";
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

describe("renderLookupOutput", () => {
  test("renders the format template with its formatting markers intact", () => {
    expect(
      renderLookupOutput("**[company name]**, seat in *[seat]*", KRS_HIT),
    ).toBe("**Żabka Polska sp. z o.o.**, seat in *Poznań*");
  });

  test("falls back to the deterministic name + seat without a template", () => {
    const fallback =
      "Żabka Polska sp. z o.o., ul. Stanisława Matyi 8, 61-586 Poznań";
    expect(renderLookupOutput(null, KRS_HIT)).toBe(fallback);
    expect(renderLookupOutput("  ", KRS_HIT)).toBe(fallback);
    // A template of only unknown tokens renders empty → same fallback.
    expect(renderLookupOutput("[no such token]", KRS_HIT)).toBe(fallback);
  });
});

describe("parseLookupMarkdown", () => {
  test("parses **bold** spans into bold runs", () => {
    expect(parseLookupMarkdown("**Acme** Ltd")).toEqual([
      { text: "Acme", bold: true },
      { text: " Ltd" },
    ]);
  });

  test("parses *italic* spans into italic runs", () => {
    expect(parseLookupMarkdown("seat in *Poznań*")).toEqual([
      { text: "seat in " },
      { text: "Poznań", italic: true },
    ]);
  });

  test("parses mixed bold and italic spans in one string", () => {
    expect(
      parseLookupMarkdown("**Acme**, with its seat in *Poznań*, KRS 123"),
    ).toEqual([
      { text: "Acme", bold: true },
      { text: ", with its seat in " },
      { text: "Poznań", italic: true },
      { text: ", KRS 123" },
    ]);
  });

  test("leaves unmatched and empty asterisks literal", () => {
    expect(parseLookupMarkdown("a * b")).toEqual([{ text: "a * b" }]);
    expect(parseLookupMarkdown("a ** b")).toEqual([{ text: "a ** b" }]);
    expect(parseLookupMarkdown("****")).toEqual([{ text: "****" }]);
    expect(parseLookupMarkdown("**dangling")).toEqual([{ text: "**dangling" }]);
  });

  test("keeps a stray asterisk inside a substituted value literal", () => {
    // Span content is asterisk-free and italic `*` cannot pair against a
    // `**` delimiter, so a `*` inside a company name defuses the whole span
    // instead of producing surprise italics.
    expect(parseLookupMarkdown("**A*B Corp**")).toEqual([
      { text: "**A*B Corp**" },
    ]);
  });
});

describe("stripLookupMarkdown", () => {
  test("strips formatting markers for the plain-text preview", () => {
    expect(stripLookupMarkdown("**Acme**, seat in *Poznań*")).toBe(
      "Acme, seat in Poznań",
    );
  });

  test("keeps unmatched asterisks", () => {
    expect(stripLookupMarkdown("2 * 3 = 6")).toBe("2 * 3 = 6");
  });
});

describe("lookupValueFromRendered", () => {
  test("returns the plain string when no formatting is present", () => {
    expect(lookupValueFromRendered("Acme Ltd, Poznań")).toBe(
      "Acme Ltd, Poznań",
    );
    // Unmatched asterisks stay literal, so the value stays a plain string.
    expect(lookupValueFromRendered("a * b")).toBe("a * b");
  });

  test("returns a rich patch value when formatting is present", () => {
    expect(lookupValueFromRendered("**Acme** Ltd")).toEqual({
      paragraphs: [{ runs: [{ text: "Acme", bold: true }, { text: " Ltd" }] }],
    });
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

  test("renders the template deterministically even when the field is Person + AI", async () => {
    // aiAdapt (Person + AI) changes nothing at lookup time: the author's
    // [token] template is substituted from the hit, no formatter involved.
    // Grammar adjustments happen downstream in the per-occurrence aiAdapt pass.
    const result = await resolveLookupFields({
      values: { buyer_krs: "0000592109" },
      fields: [
        {
          path: "buyer_krs",
          aiAdapt: true,
          lookup: {
            registry: "krs",
            aiFormat: "[company name], seat: [seat]",
          },
        },
      ],
      resolve: hitResolver(KRS_HIT),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values["buyer_krs"]).toBe(
        "Żabka Polska sp. z o.o., seat: Poznań",
      );
    }
  });

  test("turns **bold** / *italic* in the format into a rich patch value", async () => {
    const result = await resolveLookupFields({
      values: { buyer_krs: "0000592109" },
      fields: [
        {
          path: "buyer_krs",
          lookup: {
            registry: "krs",
            aiFormat: "**[company name]**, with its seat in *[seat]*",
          },
        },
      ],
      resolve: hitResolver(KRS_HIT),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values["buyer_krs"]).toEqual({
        paragraphs: [
          {
            runs: [
              { text: "Żabka Polska sp. z o.o.", bold: true },
              { text: ", with its seat in " },
              { text: "Poznań", italic: true },
            ],
          },
        ],
      });
    }
  });

  test("strips formatting markers when the field is Person + AI", async () => {
    // The aiAdapt pass rewrites plain string stubs only, so the rendered
    // output stays a string with the markers removed.
    const result = await resolveLookupFields({
      values: { buyer_krs: "0000592109" },
      fields: [
        {
          path: "buyer_krs",
          aiAdapt: true,
          lookup: {
            registry: "krs",
            aiFormat: "**[company name]**, seat: [seat]",
          },
        },
      ],
      resolve: hitResolver(KRS_HIT),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values["buyer_krs"]).toBe(
        "Żabka Polska sp. z o.o., seat: Poznań",
      );
    }
  });
});

describe("engine substitution of formatted lookup values", () => {
  const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const WRAP = (body: string) =>
    `<w:document xmlns:w="${W_NS}"><w:body>${body}</w:body></w:document>`;

  test("renders multiple runs with bold/italic rPr inline", () => {
    const xml = WRAP(
      [
        "<w:p>",
        '<w:r><w:rPr><w:sz w:val="24"/></w:rPr>',
        '<w:t xml:space="preserve">Between {{buyer_krs}} and others</w:t>',
        "</w:r>",
        "</w:p>",
      ].join(""),
    );
    const value = lookupValueFromRendered("**Acme**, seat in *Poznań*");

    const result = patchXmlPart(xml, { buyer_krs: value });

    expect(result.changed).toBe(true);
    expect(result.xml).toContain("<w:b");
    expect(result.xml).toContain("<w:i");
    expect(result.xml).toContain("Acme");
    expect(result.xml).toContain(", seat in ");
    expect(result.xml).toContain("Poznań");
    // Each replacement run inherits the marker run's other formatting:
    // the source run + 3 replacement runs + the trailing-text run.
    expect(result.xml.match(/<w:sz /gu)).toHaveLength(5);
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
