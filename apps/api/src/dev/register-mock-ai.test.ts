import { convertSchemaToJsonSchema } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { mockStructuredData } from "@/api/dev/register-mock-ai";
import { providerSafeJsonSchemaOptionsForTanStackProvider } from "@/api/lib/provider-safe-json-schema";
import { toTanStackValibotSchema } from "@/api/lib/tanstack-ai-schema";

// Runs a Valibot schema through the exact pipeline
// `generateTanStackObjectForRole` / `streamTanStackObjectForRole`
// (apps/api/src/lib/tanstack-ai-generate.ts) apply before any adapter's
// `structuredOutput` sees `outputSchema`: Valibot -> TanStack's Standard JSON
// Schema wrapper -> provider-safe projection -> TanStack's own
// `forStructuredOutput` widening. That widening step is what
// `convertSchemaForStructuredOutput` (called by the real `chat()` engine
// immediately before invoking the adapter) applies internally; `{
// forStructuredOutput: true }` reproduces it exactly.
// The mock runs under whichever provider `resolveProvider` picks (Google by
// default), and each provider's projection encodes nullability differently:
// OpenAI keeps an `anyOf` null branch, Google lowers it to `nullable: true`.
// The guards run through both so the synthesizer is covered on the actual
// default path, not just OpenAI.
const PROVIDERS = ["openai", "google"] as const;

const structuredOutputSchemaFor = (
  schema: v.GenericSchema,
  provider: (typeof PROVIDERS)[number],
): unknown => {
  const tanStackSchema = toTanStackValibotSchema(
    schema,
    // The mock path's own purpose, not "structured-output": the synthesizer
    // reads value constraints that real structured output drops.
    providerSafeJsonSchemaOptionsForTanStackProvider(
      provider,
      "mock-structured-output",
    ),
  );
  return convertSchemaToJsonSchema(tanStackSchema, {
    forStructuredOutput: true,
  });
};

// Mirrors apps/api/src/handlers/templates/prefill.ts's `prefillOutputSchema`.
const prefillOutputSchema = v.strictObject({
  fields: v.array(
    v.strictObject({
      id: v.string(),
      value: v.nullable(v.string()),
      sourceSnippet: v.nullable(v.string()),
    }),
  ),
});

// Mirrors apps/api/src/lib/workflow/verdict-engine.ts's `tierMatchSchema`.
const tierMatchSchema = v.strictObject({
  tier: v.picklist(["compliant", "fallback", "deviation"]),
  rationale: v.pipe(v.string(), v.maxLength(1000)),
  matched: v.optional(
    v.strictObject({
      kind: v.picklist(["fallback", "redLine"]),
      rank: v.number(),
    }),
  ),
});

// Mirrors apps/api/src/handlers/playbooks/derive-ask.ts's `deriveAskSchema`.
const deriveAskSchema = v.strictObject({
  question: v.pipe(v.string(), v.maxLength(1000)),
  contentType: v.picklist(["text", "date", "int"]),
});

// A schema shape none of the curated fixtures recognize: a nested object, an
// array, an enum, and a required-nullable leaf. Nullable-required (not
// optional) mirrors real structured-output schemas — OpenAI strict output
// rejects optional properties — so this parses under both provider
// projections.
const novelSchema = v.strictObject({
  title: v.pipe(v.string(), v.maxLength(200)),
  priority: v.picklist(["low", "medium", "high"]),
  tags: v.array(v.string()),
  assignee: v.nullable(v.string()),
  metadata: v.strictObject({
    createdBy: v.string(),
    reviewed: v.boolean(),
  }),
});

// A required-nullable ISO-date leaf: the `"mock"` string primitive fails
// `v.isoDate()`, so only synthesizing `null` for a nullable field keeps this
// parseable. Under the Google projection the field arrives as
// `nullable: true` rather than an `anyOf` null branch.
const nullableIsoDateSchema = v.strictObject({
  when: v.nullable(v.pipe(v.string(), v.isoDate())),
});

// A genuinely optional (not nullable) field: valid to omit, invalid as null.
// The OpenAI projection keeps enough signal (a widened `["type","null"]`
// array) to recover the optionality and omit the key.
const optionalFieldSchema = v.strictObject({
  required: v.string(),
  note: v.optional(v.string()),
});

// Mirrors apps/api/src/lib/bbox/ai-generate-b-boxes.ts's `bboxOutputSchema`
// shape: a required array that must be non-empty, plus a bounded number. The
// synthesizer derives both from the projected schema, so it produces invalid
// data the moment those constraints stop surviving the projection.
const boundedCollectionSchema = v.strictObject({
  boxes: v.pipe(
    v.array(
      v.strictObject({
        // Narrower and wider than the synthesizer's own placeholder, so both
        // the truncate and the pad path are covered.
        code: v.pipe(v.string(), v.maxLength(2)),
        label: v.pipe(v.string(), v.minLength(12)),
        page: v.pipe(v.number(), v.integer(), v.minValue(1)),
      }),
    ),
    v.minLength(1),
  ),
});

const genericSynthesisBattery = [
  ["real templates/prefill schema", prefillOutputSchema],
  ["novel nested/array/enum/nullable schema", novelSchema],
  ["required-nullable ISO-date schema", nullableIsoDateSchema],
  ["bounded non-empty collection schema", boundedCollectionSchema],
] as const;

describe("mockStructuredData", () => {
  // This is the class guard for the `{}` fallback bug: every schema a
  // structured-output caller might send (not just the two curated fixtures
  // below) must come back as something the caller's own `v.parse` accepts —
  // under either provider projection.
  for (const provider of PROVIDERS) {
    test.each(genericSynthesisBattery)(
      `synthesizes a value satisfying the %s (${provider})`,
      (_name, schema) => {
        const data = mockStructuredData(
          structuredOutputSchemaFor(schema, provider),
        );
        expect(() => v.parse(schema, data)).not.toThrow();
      },
    );
  }

  // A nullable field carrying a format constraint must synthesize as null, not
  // a mock string that fails the constraint (guards the Google `nullable: true`
  // path that a mock string silently broke).
  test("synthesizes a constrained nullable field as null", () => {
    const data = mockStructuredData(
      structuredOutputSchemaFor(nullableIsoDateSchema, "google"),
    );
    expect(v.parse(nullableIsoDateSchema, data)).toEqual({ when: null });
  });

  test("omits a genuinely optional field instead of inventing a value", () => {
    const data = mockStructuredData(
      structuredOutputSchemaFor(optionalFieldSchema, "openai"),
    );
    const parsed = v.parse(optionalFieldSchema, data);
    expect(parsed).not.toHaveProperty("note");
    expect(parsed.required).toBe("mock");
  });

  test("keeps the curated templates/prefill fixture", () => {
    const data = mockStructuredData(
      structuredOutputSchemaFor(prefillOutputSchema, "openai"),
    );
    const { fields } = v.parse(prefillOutputSchema, data);
    expect(fields.map(({ id }) => id)).toEqual(
      Array.from({ length: 16 }, (_, index) => `f${index + 1}`),
    );
    expect(fields.at(3)).toEqual({
      id: "f4",
      value: "Northstar Robotics, Inc.",
      sourceSnippet:
        "Northstar Robotics, Inc., a Delaware corporation with offices at 548 Market Street, San Francisco, California 94104, United States",
    });
    expect(fields.at(5)).toEqual({
      id: "f6",
      value: null,
      sourceSnippet: null,
    });
    expect(fields.at(8)).toEqual({
      id: "f9",
      value: null,
      sourceSnippet: null,
    });
  });

  test("keeps the curated playbook.verdict tier-match fixture", () => {
    const data = mockStructuredData(
      structuredOutputSchemaFor(tierMatchSchema, "openai"),
    );
    expect(v.parse(tierMatchSchema, data)).toEqual({
      tier: "deviation",
      rationale: "Mock verdict.",
    });
  });

  test("keeps the curated playbook.derive-ask fixture", () => {
    const data = mockStructuredData(
      structuredOutputSchemaFor(deriveAskSchema, "openai"),
    );
    expect(v.parse(deriveAskSchema, data)).toEqual({
      question: "What does the contract say about this issue?",
      contentType: "text",
    });
  });

  test("throws rather than silently returning an unsatisfiable schema", () => {
    expect(() =>
      mockStructuredData({
        type: "object",
        properties: { odd: {} },
        required: ["odd"],
      }),
    ).toThrow();
  });
});
