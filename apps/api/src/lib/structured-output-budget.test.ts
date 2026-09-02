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

  test("counts non-ASCII option labels as the UTF-8 bytes they occupy", () => {
    // A workspace's own select options are embedded in the schema, so a CJK
    // or emoji label costs more on the wire than its UTF-16 length suggests.
    const schema = {
      enum: ["契約書", "解約通知", "秘密保持契約", "🇨🇿 smlouva"],
    };
    const serialized = JSON.stringify(schema);

    // The fixture must actually differ, or the assertion below is vacuous.
    expect(serialized.length).toBeLessThan(
      Buffer.byteLength(serialized, "utf-8"),
    );
    expect(measureStructuredOutputSchema(schema).bytes).toBe(
      Buffer.byteLength(serialized, "utf-8"),
    );
  });

  test("admits an ASCII schema at exactly the same size either way", () => {
    const schema = { enum: ["contract", "termination-notice"] };
    const serialized = JSON.stringify(schema);

    expect(measureStructuredOutputSchema(schema).bytes).toBe(serialized.length);
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

  test("holds a Bedrock-hosted Claude to the Anthropic budget", () => {
    // Bedrock names the vendor after an optional region, separated by dots.
    expect(
      resolveStructuredOutputBudget({
        provider: "bedrock",
        modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      }),
    ).toEqual({
      provider: "anthropic",
      budget: STRUCTURED_OUTPUT_BUDGETS.anthropic,
    });
    expect(
      resolveStructuredOutputBudget({
        provider: "bedrock",
        modelId: "openai.gpt-oss-120b-1:0",
      }).provider,
    ).toBe("openai");
    // A vendor with no budget of its own keeps Bedrock's.
    expect(
      resolveStructuredOutputBudget({
        provider: "bedrock",
        modelId: "us.amazon.nova-pro-v1:0",
      }).provider,
    ).toBe("bedrock");
  });

  test("never reads a vendor out of a first-party model id", () => {
    // A first-party provider compiles the schema itself, so its own id is
    // never parsed — an id that happened to contain another vendor's name
    // must not redirect the budget.
    expect(
      resolveStructuredOutputBudget({
        provider: "mistral",
        modelId: "mistral-large-latest",
      }).provider,
    ).toBe("mistral");
    expect(
      resolveStructuredOutputBudget({
        provider: "google",
        modelId: "gemini-3.7-flash",
      }).provider,
    ).toBe("google");
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

  test("rejects a non-ASCII schema that only fits when counted as UTF-16", () => {
    // Sized so the string length lands under Anthropic's budget while the
    // UTF-8 payload the provider receives is over it: counting code units
    // would admit a request the compiler then rejects.
    const label = "契約書類";
    const schema = {
      enum: Array.from(
        {
          length: Math.ceil(
            STRUCTURED_OUTPUT_BUDGETS.anthropic.maxSchemaBytes / 16,
          ),
        },
        (_, index) => `${label}${index}`,
      ),
    };
    const serialized = JSON.stringify(schema);

    expect(serialized.length).toBeLessThan(
      STRUCTURED_OUTPUT_BUDGETS.anthropic.maxSchemaBytes,
    );
    expect(Buffer.byteLength(serialized, "utf-8")).toBeGreaterThan(
      STRUCTURED_OUTPUT_BUDGETS.anthropic.maxSchemaBytes,
    );

    expect(
      Result.isError(
        checkStructuredOutputBudget({
          provider: "anthropic",
          modelId: ANTHROPIC_MODEL_ID,
          schema,
        }),
      ),
    ).toBe(true);
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
