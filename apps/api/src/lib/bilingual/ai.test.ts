import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import type {
  AIUsageMetering,
  TanStackAIAnalyticsCallbacks,
} from "@/api/lib/analytics/tanstack-ai";
import type { BilingualAIDocumentContext } from "@/api/lib/bilingual/ai";
import type { FormattedBilingualUnit } from "@/api/lib/bilingual/formatting";
import { toSafeId } from "@/api/lib/branded-types";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";

type GenerateOptions = {
  analytics: TanStackAIAnalyticsCallbacks;
  messages: { content: { content: string; type: "text" }[] }[];
};
type FormattedOutput = {
  items: { n: number; spans: { id: string; text: string }[] }[];
};

const outputs: FormattedOutput[] = [];
const messages: GenerateOptions["messages"][] = [];
const dispatchedCallbacks: TanStackAIAnalyticsCallbacks[] = [];
const generateObjectMock = mock(
  async ({ analytics, messages: request }: GenerateOptions) => {
    dispatchedCallbacks.push(analytics);
    messages.push(request);
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

const {
  buildBilingualDocumentRequest,
  SOURCE_DOCUMENT_CACHE_CHARS_MAX,
  translateFormattedBatch,
} = await import("@/api/lib/bilingual/ai");

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
  sourceDocument: [
    {
      rowId: "source-row",
      ordinal: 99,
      kind: "paragraph",
      inTable: false,
      sourceParaId: "source-paragraph",
      sourceText: "Stable source",
    },
  ],
} satisfies BilingualAIDocumentContext;

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
    messages.length = 0;
    dispatchedCallbacks.length = 0;
    generateObjectMock.mockClear();
    analytics = installRecordingAnalytics();
  });

  afterEach(() => {
    analytics.restore();
  });

  test("marks the complete stable input before request-specific text", () => {
    const request = buildBilingualDocumentRequest(
      { ...context, promptCachingEnabled: true },
      "chat",
      "Translate rows 1 through 8",
    );
    const message = request.messages.at(0);
    if (!message || !Array.isArray(message.content)) {
      throw new Error("expected a multipart user message");
    }
    const source = message.content.at(0);
    const variable = message.content.at(1);
    if (source?.type !== "text" || variable?.type !== "text") {
      throw new Error("expected text message parts");
    }

    expect(source.content).toContain("Input document:\n#99 [paragraph]");
    expect(source.metadata).toEqual({
      cache_control: { type: "ephemeral", ttl: "5m" },
    });
    expect(variable.content).toBe("Translate rows 1 through 8");
    expect(request.caching).toEqual({
      enabled: true,
      ttl: "5m",
      scopeKey: "document-version-fixture",
    });
  });

  test("bounds the cached source region for unusually large documents", () => {
    const sourceDocument = Array.from({ length: 4 }, (_unused, index) => ({
      rowId: `large-row-${index}`,
      ordinal: index + 1,
      kind: "paragraph" as const,
      inTable: false,
      sourceParaId: `large-paragraph-${index}`,
      sourceText: "x".repeat(20_000),
    }));
    const request = buildBilingualDocumentRequest(
      { ...context, sourceDocument },
      "chat",
      "Translate one batch",
    );
    const message = request.messages.at(0);
    if (!message || !Array.isArray(message.content)) {
      throw new Error("expected a multipart user message");
    }
    const source = message.content.at(0);
    if (source?.type !== "text") {
      throw new Error("expected a text source part");
    }

    expect(source.content.length).toBeLessThanOrEqual(
      "Input document:\n".length + SOURCE_DOCUMENT_CACHE_CHARS_MAX,
    );
    expect(source.content).toEndWith("[Cached input prefix truncated]");
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
    const firstContent = messages.at(0)?.at(0)?.content;
    const retryContent = messages.at(1)?.at(0)?.content;
    expect(firstContent?.at(0)?.content).toBe(retryContent?.at(0)?.content);
    expect(retryContent?.at(1)?.content).toContain("Contract repair:");
    expect(retryContent?.at(1)?.content).not.toContain("#1:");
    expect(retryContent?.at(1)?.content).toContain("#2:");
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
