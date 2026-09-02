import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  checkStructuredOutputBudget,
  measureStructuredOutputSchema,
  resolveStructuredOutputBudget,
  splitPropertiesForBudget,
  STRUCTURED_OUTPUT_BUDGETS,
} from "@/api/lib/structured-output-budget";

const ANTHROPIC_MODEL_ID = "claude-sonnet-5";
const OPENAI_MODEL_ID = "gpt-5.6-luna";

const expectError = <TValue, TError>(
  result: Result<TValue, TError>,
): TError => {
  if (!Result.isError(result)) {
    throw new TypeError("Expected an error result.");
  }
  return result.error;
};

const expectValue = <TValue, TError>(
  result: Result<TValue, TError>,
): TValue => {
  if (Result.isError(result)) {
    throw new TypeError(`Expected an ok result, got ${String(result.error)}`);
  }
  return result.value;
};

describe("measuring a projected structured-output schema", () => {
  test("reports the serialized size the provider compiles", () => {
    const schema = {
      type: "object",
      properties: { answer: { type: "string" } },
    };

    expect(measureStructuredOutputSchema(schema).bytes).toBe(
      JSON.stringify(schema).length,
    );
  });

  test("counts a union anywhere in the tree, however it is spelled", () => {
    const measured = measureStructuredOutputSchema({
      type: "object",
      properties: {
        // `type` as an array.
        answer: { type: ["string", "null"] },
        // `anyOf` nested under an array's items.
        citations: {
          type: "array",
          items: { anyOf: [{ type: "string" }, { type: "number" }] },
        },
        // `oneOf` nested two objects deep.
        justification: {
          type: "object",
          properties: { source: { oneOf: [{ type: "string" }] } },
        },
      },
    });

    expect(measured.unionParameters).toBe(3);
  });

  test("counts no union in a schema that has none", () => {
    expect(
      measureStructuredOutputSchema({
        type: "object",
        properties: { answer: { type: "string" } },
      }).unionParameters,
    ).toBe(0);
  });
});

describe("resolving which provider's budget applies", () => {
  test("uses the addressed provider when it compiles the grammar itself", () => {
    expect(
      resolveStructuredOutputBudget({
        provider: "anthropic",
        modelId: ANTHROPIC_MODEL_ID,
      }),
    ).toEqual({
      provider: "anthropic",
      budget: STRUCTURED_OUTPUT_BUDGETS.anthropic,
    });
  });

  test("holds an OpenRouter id routed to Anthropic to the Anthropic budget", () => {
    expect(
      resolveStructuredOutputBudget({
        provider: "openrouter",
        modelId: `anthropic/${ANTHROPIC_MODEL_ID}`,
      }),
    ).toEqual({
      provider: "anthropic",
      budget: STRUCTURED_OUTPUT_BUDGETS.anthropic,
    });
  });

  test("holds an OpenRouter id routed to OpenAI to the OpenAI budget", () => {
    expect(
      resolveStructuredOutputBudget({
        provider: "openrouter",
        modelId: `openai/${OPENAI_MODEL_ID}`,
      }),
    ).toEqual({
      provider: "openai",
      budget: STRUCTURED_OUTPUT_BUDGETS.openai,
    });
  });

  test("falls back to the OpenRouter placeholder for an unrecognized upstream", () => {
    expect(
      resolveStructuredOutputBudget({
        provider: "openrouter",
        modelId: "some-lab/experimental-1",
      }),
    ).toEqual({
      provider: "openrouter",
      budget: STRUCTURED_OUTPUT_BUDGETS.openrouter,
    });
    expect(
      resolveStructuredOutputBudget({
        provider: "openrouter",
        modelId: "unprefixed-model",
      }).provider,
    ).toBe("openrouter");
  });
});

describe("checking a schema against a provider budget", () => {
  test("accepts a schema inside the budget and reports what it measured", () => {
    const measured = expectValue(
      checkStructuredOutputBudget({
        provider: "anthropic",
        modelId: ANTHROPIC_MODEL_ID,
        schema: { type: "object", properties: { answer: { type: "string" } } },
      }),
    );

    expect(measured.bytes).toBeLessThan(
      STRUCTURED_OUTPUT_BUDGETS.anthropic.maxSchemaBytes,
    );
    expect(measured.unionParameters).toBe(0);
  });

  test("rejects a schema over the byte budget with the measurement and the budget", () => {
    const oversized = {
      type: "object",
      description: "x".repeat(
        STRUCTURED_OUTPUT_BUDGETS.anthropic.maxSchemaBytes,
      ),
    };

    const error = expectError(
      checkStructuredOutputBudget({
        provider: "anthropic",
        modelId: ANTHROPIC_MODEL_ID,
        schema: oversized,
      }),
    );

    expect(error.provider).toBe("anthropic");
    expect(error.measured.bytes).toBeGreaterThan(
      STRUCTURED_OUTPUT_BUDGETS.anthropic.maxSchemaBytes,
    );
    expect(error.budget).toEqual(STRUCTURED_OUTPUT_BUDGETS.anthropic);
    expect(error.message).toContain("schema bytes over the");
  });

  test("rejects too many union parameters even when the schema is small", () => {
    const unions = Object.fromEntries(
      Array.from(
        { length: STRUCTURED_OUTPUT_BUDGETS.anthropic.maxUnionParameters + 1 },
        (_, index) => [`f${index}`, { type: ["string", "null"] }],
      ),
    );
    const schema = { type: "object", properties: unions };

    expect(JSON.stringify(schema).length).toBeLessThan(
      STRUCTURED_OUTPUT_BUDGETS.anthropic.maxSchemaBytes,
    );
    const error = expectError(
      checkStructuredOutputBudget({
        provider: "anthropic",
        modelId: ANTHROPIC_MODEL_ID,
        schema,
      }),
    );

    expect(error.measured.unionParameters).toBe(
      STRUCTURED_OUTPUT_BUDGETS.anthropic.maxUnionParameters + 1,
    );
    expect(error.message).toContain("union parameters over the");
  });

  test("accepts on OpenAI what it rejects on Anthropic", () => {
    const schema = {
      type: "object",
      description: "x".repeat(
        STRUCTURED_OUTPUT_BUDGETS.anthropic.maxSchemaBytes,
      ),
    };

    expect(
      Result.isError(
        checkStructuredOutputBudget({
          provider: "anthropic",
          modelId: ANTHROPIC_MODEL_ID,
          schema,
        }),
      ),
    ).toBe(true);
    expect(
      Result.isError(
        checkStructuredOutputBudget({
          provider: "openai",
          modelId: OPENAI_MODEL_ID,
          schema,
        }),
      ),
    ).toBe(false);
  });

  test("rejects an OpenRouter request whose upstream is Anthropic", () => {
    const schema = {
      type: "object",
      description: "x".repeat(
        STRUCTURED_OUTPUT_BUDGETS.anthropic.maxSchemaBytes,
      ),
    };

    const error = expectError(
      checkStructuredOutputBudget({
        provider: "openrouter",
        modelId: `anthropic/${ANTHROPIC_MODEL_ID}`,
        schema,
      }),
    );

    // The budget names the compiler, not the proxy the request was sent to.
    expect(error.provider).toBe("anthropic");
    expect(
      Result.isError(
        checkStructuredOutputBudget({
          provider: "openrouter",
          modelId: `openai/${OPENAI_MODEL_ID}`,
          schema,
        }),
      ),
    ).toBe(false);
  });
});

// A stand-in schema builder: one property costs a fixed number of bytes, so a
// chunk's size is exactly predictable from the budget. The real projection is
// exercised by the property test next to this file.
const FIXED_BYTES_PER_PROPERTY = 1000;

const fixedSizeSchema = (properties: readonly string[]) => ({
  properties: properties.map((name) => ({
    name,
    filler: "x".repeat(FIXED_BYTES_PER_PROPERTY),
  })),
});

describe("splitting properties to fit a provider budget", () => {
  test("fills each chunk up to the budget and keeps the input order", () => {
    const properties = Array.from({ length: 20 }, (_, index) => `p${index}`);

    const chunks = expectValue(
      splitPropertiesForBudget({
        provider: "anthropic",
        modelId: ANTHROPIC_MODEL_ID,
        properties,
        buildSchema: fixedSizeSchema,
      }),
    );

    expect(chunks.flat()).toEqual(properties);
    expect(chunks.every((chunk) => chunk.length > 0)).toBe(true);
    for (const chunk of chunks) {
      expect(
        Result.isError(
          checkStructuredOutputBudget({
            provider: "anthropic",
            modelId: ANTHROPIC_MODEL_ID,
            schema: fixedSizeSchema(chunk),
          }),
        ),
      ).toBe(false);
    }
    // Every chunk but the last is full: the split is greedy, not one-per-call.
    const chunkSizes = chunks.map((chunk) => chunk.length);
    const fullChunkSize = chunkSizes.at(0) ?? 0;
    expect(fullChunkSize).toBeGreaterThan(1);
    expect(
      chunkSizes.slice(0, -1).every((size) => size === fullChunkSize),
    ).toBe(true);
  });

  test("splits an OpenRouter batch by its upstream's budget, not the placeholder", () => {
    const properties = Array.from({ length: 20 }, (_, index) => `p${index}`);

    const viaAnthropic = expectValue(
      splitPropertiesForBudget({
        provider: "openrouter",
        modelId: `anthropic/${ANTHROPIC_MODEL_ID}`,
        properties,
        buildSchema: fixedSizeSchema,
      }),
    );
    const viaUnknownUpstream = expectValue(
      splitPropertiesForBudget({
        provider: "openrouter",
        modelId: "some-lab/experimental-1",
        properties,
        buildSchema: fixedSizeSchema,
      }),
    );

    expect(viaAnthropic.length).toBeGreaterThan(viaUnknownUpstream.length);
    expect(viaAnthropic.flat()).toEqual(properties);
  });

  test("reports the property that cannot fit alone instead of looping forever", () => {
    const error = expectError(
      splitPropertiesForBudget({
        provider: "anthropic",
        modelId: ANTHROPIC_MODEL_ID,
        properties: ["fits", "never-fits", "fits-too"],
        buildSchema: (properties) =>
          properties.includes("never-fits")
            ? {
                filler: "x".repeat(
                  STRUCTURED_OUTPUT_BUDGETS.anthropic.maxSchemaBytes,
                ),
              }
            : fixedSizeSchema(properties),
      }),
    );

    expect(error.provider).toBe("anthropic");
    expect(error.measured.bytes).toBeGreaterThan(
      STRUCTURED_OUTPUT_BUDGETS.anthropic.maxSchemaBytes,
    );
  });

  test("returns no chunks for no properties", () => {
    expect(
      expectValue(
        splitPropertiesForBudget({
          provider: "anthropic",
          modelId: ANTHROPIC_MODEL_ID,
          properties: [],
          buildSchema: fixedSizeSchema,
        }),
      ),
    ).toEqual([]);
  });
});
