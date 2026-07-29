import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";

import {
  CanaryProviderRunError,
  createPdfCanaryMessages,
  errorSummary,
  PDF_CANARY_TOKEN,
  toolRoundTripInputSchema,
  toolRoundTripInputSchemaForProvider,
  toolRoundTripPromptForProvider,
} from "./ai-provider-canary";

describe("AI provider PDF canary contract", () => {
  test("sends a real inline PDF rather than a text-only pdf-role probe", () => {
    const message = createPdfCanaryMessages().at(0);
    expect(message?.role).toBe("user");
    if (!message || typeof message.content === "string") {
      throw new Error("Expected multimodal PDF canary message");
    }

    const text = message.content.find((part) => part.type === "text");
    expect(text?.content).not.toContain(PDF_CANARY_TOKEN);
    const document = message.content.find((part) => part.type === "document");
    expect(document?.source.type).toBe("data");
    if (!document || document.source.type !== "data") {
      throw new Error("Expected inline PDF canary data");
    }

    const bytes = Buffer.from(document.source.value, "base64");
    expect(bytes.subarray(0, 8).toString()).toBe("%PDF-1.4");
    expect(bytes.toString()).toContain(PDF_CANARY_TOKEN);
  });
});

describe("AI provider canary tool contract", () => {
  test("keeps the omission marker outside the application schema", () => {
    const requiredInput = {
      count: 7,
      value: "stella-canary",
    };

    expect(v.safeParse(toolRoundTripInputSchema, requiredInput).success).toBe(
      true,
    );
    expect(
      v.safeParse(toolRoundTripInputSchema, {
        ...requiredInput,
        optionalNote: "any string",
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(toolRoundTripInputSchema, {
        ...requiredInput,
        optionalNote: null,
      }).success,
    ).toBe(false);

    expect(
      toTanStackToolSchema(toolRoundTripInputSchema)[
        "~standard"
      ].jsonSchema.input({ target: "draft-07" }),
    ).toMatchObject({
      properties: {
        optionalNote: { pattern: "a^", type: "string" },
      },
      required: ["count", "value"],
    });
  });

  test("requests the provider representation used by each adapter", () => {
    expect(toolRoundTripPromptForProvider("openai")).toContain(
      "Set optionalNote to null.",
    );
    expect(toolRoundTripPromptForProvider("mistral")).toContain(
      "Set optionalNote to null.",
    );
    expect(toolRoundTripPromptForProvider("openrouter")).toContain(
      "Do not include optionalNote.",
    );
    expect(
      toolRoundTripInputSchemaForProvider("mistral")[
        "~standard"
      ].jsonSchema.input({ target: "draft-07" }),
    ).toMatchObject({
      properties: {
        optionalNote: { type: "string", enum: [] },
      },
      required: ["count", "value"],
    });
  });
});

describe("AI provider canary error summaries", () => {
  test("reports only bounded provider codes and the failed tool stage", () => {
    const signal = new AbortController().signal;

    expect(
      errorSummary(
        new CanaryProviderRunError(
          { error: { code: "provider_error" } },
          "after-tool-result",
        ),
        signal,
      ),
    ).toBe("provider stream error after tool result (provider_error)");
  });

  test("does not include provider messages or unbounded code fields", () => {
    const signal = new AbortController().signal;
    const error = new CanaryProviderRunError(
      {
        code: "unsafe code containing request material",
        message: "provider response body",
      },
      "before-tool-call",
    );

    expect(errorSummary(error, signal)).toBe(
      "provider stream error before tool call",
    );
    expect(
      errorSummary(
        new CanaryProviderRunError(
          { code: "client-matter-name" },
          "before-tool-call",
        ),
        signal,
      ),
    ).toBe("provider stream error before tool call");
  });

  test("prefers a numeric provider status without exposing the event", () => {
    const signal = new AbortController().signal;
    const error = new CanaryProviderRunError(
      { rawEvent: { statusCode: 429, body: "not logged" } },
      "after-tool-call",
    );

    expect(errorSummary(error, signal)).toBe("provider HTTP 429");
  });
});
