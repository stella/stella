import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import type {
  AIUsageMetering,
  TanStackAIAnalyticsCallbacks,
} from "@/api/lib/analytics/tanstack-ai";
import type { BilingualAIContext } from "@/api/lib/bilingual/ai";
import type { FormattedBilingualUnit } from "@/api/lib/bilingual/formatting";
import { toSafeId } from "@/api/lib/branded-types";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";

type GenerateOptions = {
  analytics: TanStackAIAnalyticsCallbacks;
  prompt: string;
};
type FormattedOutput = {
  items: { n: number; spans: { id: string; text: string }[] }[];
};

const outputs: FormattedOutput[] = [];
const prompts: string[] = [];
const dispatchedCallbacks: TanStackAIAnalyticsCallbacks[] = [];
const generateObjectMock = mock(
  async ({ analytics, prompt }: GenerateOptions) => {
    dispatchedCallbacks.push(analytics);
    prompts.push(prompt);
    const output = outputs.shift();
    if (!output) {
      throw new Error("test did not configure a model output");
    }
    return await Promise.resolve(output);
  },
);

void mock.module("@/api/lib/tanstack-ai-generate", () => ({
  abortControllerFromSignal: mock(),
  generateTanStackObjectForRole: generateObjectMock,
  generateTanStackTextForRole: mock(),
  mergeGenerationOptions: mock(),
  resolveTanStackTextModel: mock(),
  streamTanStackObjectForRole: mock(),
  streamTanStackTextForRole: mock(),
  systemPromptsPatch: mock(),
}));

const { translateFormattedBatch } = await import("@/api/lib/bilingual/ai");

const organizationId = toSafeId<"organization">("organization-fixture");
const workspaceId = toSafeId<"workspace">("workspace-fixture");
const safeDb: SafeDb = async () => {
  throw new Error("safeDb should not be called by this test");
};
const usageMetering = {
  actionType: "doc_review",
  organizationId,
  safeDb,
  serviceTier: "standard",
  userId: toSafeId<"user">("user-fixture"),
  workspaceId,
} satisfies AIUsageMetering;
const context = {
  organizationId,
  workspaceId,
  orgAIConfig: null,
  promptCachingEnabled: false,
  usageMetering,
  abortSignal: AbortSignal.timeout(10_000),
  scopeKey: "document-version-fixture",
} satisfies BilingualAIContext;

const formattedUnit = (
  ordinal: number,
  spans: readonly { id: string; text: string }[],
): FormattedBilingualUnit => ({
  rowId: `row-${ordinal}`,
  ordinal,
  kind: "paragraph",
  inTable: false,
  sourceParaId: `source-${ordinal}`,
  sourceText: spans.map((span) => span.text).join(""),
  inline: spans.map((span) => ({ type: "text", ...span })),
  spans,
});

describe("formatted bilingual AI boundary", () => {
  let analytics: RecordingAnalytics;

  beforeEach(() => {
    outputs.length = 0;
    prompts.length = 0;
    dispatchedCallbacks.length = 0;
    generateObjectMock.mockClear();
    analytics = installRecordingAnalytics();
  });

  afterEach(() => {
    analytics.restore();
  });

  test("retries only rows whose ordered span contract is invalid", async () => {
    const accepted = formattedUnit(1, [
      { id: "row-1:s0001", text: "Hello" },
      { id: "row-1:s0002", text: " world" },
    ]);
    const repaired = formattedUnit(2, [
      { id: "row-2:s0001", text: "Goodbye" },
      { id: "row-2:s0002", text: " world" },
    ]);
    outputs.push(
      {
        items: [
          {
            n: 1,
            spans: [
              { id: "row-1:s0001", text: "Ahoj" },
              { id: "row-1:s0002", text: " světe" },
            ],
          },
          {
            n: 2,
            spans: [{ id: "wrong", text: "Neplatné" }],
          },
        ],
      },
      {
        items: [
          {
            n: 2,
            spans: [
              { id: "row-2:s0001", text: "Sbohem" },
              { id: "row-2:s0002", text: " světe" },
            ],
          },
        ],
      },
    );

    const result = await translateFormattedBatch(
      { batch: [accepted, repaired], preceding: [], glossary: [] },
      { sourceLang: "en", targetLang: "cs" },
      context,
    );

    expect(generateObjectMock).toHaveBeenCalledTimes(2);
    // The retry reuses one callbacks instance, so both attempts stay on one
    // trace instead of reporting as two independent generations.
    expect(dispatchedCallbacks.at(1)).toBe(dispatchedCallbacks.at(0));
    expect(dispatchedCallbacks.at(0)?.middleware.name).toBe(
      "stella-tanstack-analytics",
    );
    expect(prompts.at(1)).toContain("Contract repair:");
    expect(prompts.at(1)).not.toContain("#1:");
    expect(prompts.at(1)).toContain("#2:");
    expect(result.get(1)).toEqual({
      text: "Ahoj světe",
      spans: [
        { id: "row-1:s0001", text: "Ahoj" },
        { id: "row-1:s0002", text: " světe" },
      ],
    });
    expect(result.get(2)).toEqual({
      text: "Sbohem světe",
      spans: [
        { id: "row-2:s0001", text: "Sbohem" },
        { id: "row-2:s0002", text: " světe" },
      ],
    });
  });

  test("rejects pathological inline token counts before model dispatch", async () => {
    const spans = Array.from({ length: 2049 }, (_unused, index) => ({
      id: `row-1:s${index}`,
      text: "",
    }));

    const translation = translateFormattedBatch(
      { batch: [formattedUnit(1, spans)], preceding: [], glossary: [] },
      { sourceLang: "en", targetLang: "cs" },
      context,
    );

    const rejection = await translation.then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toMatchObject({
      _tag: "BilingualAIContractError",
    });
    expect(generateObjectMock).not.toHaveBeenCalled();
    // A rejected contract is the caller's error to handle, not a captured defect.
    expect(analytics.exceptions()).toEqual([]);
  });

  test("rejects cumulative formatted row serialization before model dispatch", async () => {
    const batch = Array.from({ length: 8 }, (_unusedBatch, batchIndex) => {
      const ordinal = batchIndex + 1;
      return formattedUnit(
        ordinal,
        Array.from({ length: 2048 }, (_unusedSpan, spanIndex) => ({
          id: `row-${ordinal}:s${spanIndex}`,
          text: spanIndex === 0 ? "x" : "",
        })),
      );
    });

    const translation = translateFormattedBatch(
      { batch, preceding: [], glossary: [] },
      { sourceLang: "en", targetLang: "cs" },
      context,
    );

    const rejection = await translation.then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toMatchObject({
      _tag: "BilingualAIContractError",
    });
    expect(generateObjectMock).not.toHaveBeenCalled();
    // A rejected contract is the caller's error to handle, not a captured defect.
    expect(analytics.exceptions()).toEqual([]);
  });
});
