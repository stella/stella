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
const structuredOutputSchemaFor = (schema: v.GenericSchema): unknown => {
  const tanStackSchema = toTanStackValibotSchema(
    schema,
    providerSafeJsonSchemaOptionsForTanStackProvider("openai"),
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
// array, an enum, a required-nullable leaf, and a genuinely optional leaf,
// all in one place.
const novelSchema = v.strictObject({
  title: v.pipe(v.string(), v.maxLength(200)),
  priority: v.picklist(["low", "medium", "high"]),
  tags: v.array(v.string()),
  assignee: v.nullable(v.string()),
  metadata: v.strictObject({
    createdBy: v.string(),
    reviewed: v.boolean(),
  }),
  optionalNote: v.optional(v.string()),
});

const genericSynthesisBattery = [
  ["real templates/prefill schema", prefillOutputSchema],
  ["novel nested/array/enum/nullable schema", novelSchema],
] as const;

describe("mockStructuredData", () => {
  // This is the class guard for the `{}` fallback bug: every schema a
  // structured-output caller might send (not just the two curated fixtures
  // below) must come back as something the caller's own `v.parse` accepts.
  test.each(genericSynthesisBattery)(
    "synthesizes a value satisfying the %s",
    (_name, schema) => {
      const data = mockStructuredData(structuredOutputSchemaFor(schema));
      expect(() => v.parse(schema, data)).not.toThrow();
    },
  );

  test("omits a genuinely optional field instead of inventing a value", () => {
    const data = mockStructuredData(structuredOutputSchemaFor(novelSchema));
    const parsed = v.parse(novelSchema, data);
    expect(parsed).not.toHaveProperty("optionalNote");
    expect(parsed.assignee).toBeNull();
    expect(parsed.tags).toEqual([]);
  });

  test("synthesizes the templates/prefill schema as an empty field list", () => {
    const data = mockStructuredData(
      structuredOutputSchemaFor(prefillOutputSchema),
    );
    expect(v.parse(prefillOutputSchema, data)).toEqual({ fields: [] });
  });

  test("keeps the curated playbook.verdict tier-match fixture", () => {
    const data = mockStructuredData(structuredOutputSchemaFor(tierMatchSchema));
    expect(v.parse(tierMatchSchema, data)).toEqual({
      tier: "deviation",
      rationale: "Mock verdict.",
    });
  });

  test("keeps the curated playbook.derive-ask fixture", () => {
    const data = mockStructuredData(structuredOutputSchemaFor(deriveAskSchema));
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
