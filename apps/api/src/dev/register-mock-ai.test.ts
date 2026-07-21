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
    providerSafeJsonSchemaOptionsForTanStackProvider(provider),
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

const genericSynthesisBattery = [
  ["real templates/prefill schema", prefillOutputSchema],
  ["novel nested/array/enum/nullable schema", novelSchema],
  ["required-nullable ISO-date schema", nullableIsoDateSchema],
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

  test("synthesizes the templates/prefill schema as an empty field list", () => {
    const data = mockStructuredData(
      structuredOutputSchemaFor(prefillOutputSchema, "openai"),
    );
    expect(v.parse(prefillOutputSchema, data)).toEqual({ fields: [] });
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
