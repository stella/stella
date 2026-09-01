/**
 * The model-dispatch boundary of reference grading: what tenant scope reaches
 * model ingress, what a provider failure reports, and when a batch is sent
 * back for repair. The derivation itself is covered by
 * `reference-grade.test.ts`, the repair rules by
 * `reference-grade-repair.test.ts`.
 */

import type { ModelMessage } from "@tanstack/ai";
import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import type { AIUsageMetering } from "@/api/lib/analytics/tanstack-ai";
import { SERVER_ANALYTICS_EVENTS } from "@/api/lib/analytics/types";
import { toSafeId, type SafeId } from "@/api/lib/branded-types";
import { NEUTRAL_PERSPECTIVE } from "@/api/lib/document-review/contract";
import { gradeReferencePositions } from "@/api/lib/document-review/reference-grade";
import type { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import type {
  RecordingAnalytics,
  RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

type CapturedGenerateOptions = {
  tenantWorkspaceIds: readonly SafeId<"workspace">[];
  messages: readonly ModelMessage[];
};

const POSITION_ID = "11111111-1111-4111-8111-111111111111";

const answer = (blockId: string) => ({
  positionId: POSITION_ID,
  assessment: "different" as const,
  consensus: "single" as const,
  rationale: "The target differs.",
  recommendation: "",
  impact: "unknown" as const,
  direction: "unknown" as const,
  delta: {
    targetValue: null,
    standardValue: null,
    items: [],
    term: "",
    inTarget: false,
    inStandard: false,
  },
  proposedText: null,
  targetCitations: [{ blockId }],
});

const capturedGenerateOptions: CapturedGenerateOptions[] = [];
/** Answers the mock hands back in order; a call past the queue answers
 *  nothing. Queued rather than `mockResolvedValueOnce`, which would skip the
 *  capture above. */
const queuedAnswers: { findings: ReturnType<typeof answer>[] }[] = [];
const generateObjectMock = mock(async (options: CapturedGenerateOptions) => {
  capturedGenerateOptions.push(options);
  return await Promise.resolve(queuedAnswers.shift() ?? { findings: [] });
});
const generateObjectForTest =
  asTestRaw<typeof generateTanStackObjectForRole>(generateObjectMock);

const organizationId = toSafeId<"organization">("organization-fixture");
const workspaceId = toSafeId<"workspace">("workspace-fixture");
const targetFieldId = toSafeId<"field">("target-field-fixture");
const referenceFieldId = toSafeId<"field">("reference-field-fixture");

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

const grade = async () =>
  await gradeReferencePositions({
    perspective: NEUTRAL_PERSPECTIVE,
    positions: [
      {
        sourceId: POSITION_ID,
        issue: "Payment timing",
        termKind: "language",
        passages: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            workspaceId,
            entityId: toSafeId<"entity">("reference-entity-fixture"),
            fileFieldId: referenceFieldId,
            entityVersionId: toSafeId<"entityVersion">(
              "reference-version-fixture",
            ),
            blockId: "reference-block",
            text: "Beta term",
          },
        ],
      },
    ],
    target: {
      kind: "docx",
      fileFieldId: targetFieldId,
      fileId: "target-file-fixture",
      simplifiedName: "F0",
      blocks: [{ id: "target-block", kind: "paragraph", text: "Alpha term" }],
    },
    targetLanguage: null,
    targetEntityVersionId: toSafeId<"entityVersion">("target-version-fixture"),
    referenceEntityVersionIds: [
      toSafeId<"entityVersion">("reference-version-fixture"),
    ],
    organizationId,
    workspaceId,
    orgAIConfig: null,
    promptCachingEnabled: false,
    serviceTier: "standard",
    usageMetering,
    abortSignal: AbortSignal.timeout(1000),
    generateObjectForRole: generateObjectForTest,
  });

describe("reference grading AI boundary", () => {
  let analytics: RecordingAnalytics;
  let logs: RecordingLogger;

  beforeEach(() => {
    capturedGenerateOptions.length = 0;
    queuedAnswers.length = 0;
    analytics = installRecordingAnalytics();
    logs = installRecordingLogger();
  });

  afterEach(() => {
    analytics.restore();
    logs.restore();
  });

  test("passes the authorized workspace scope to model ingress", async () => {
    queuedAnswers.push({ findings: [answer("target-block")] });

    const result = await grade();

    expect(Result.isOk(result)).toBe(true);
    expect(capturedGenerateOptions.at(0)?.tenantWorkspaceIds).toEqual([
      workspaceId,
    ]);
    expect(analytics.exceptions()).toEqual([]);
  });

  test("a batch that checks out is one call", async () => {
    queuedAnswers.push({ findings: [answer("target-block")] });

    await grade();

    expect(capturedGenerateOptions).toHaveLength(1);
  });

  test("an answer the documents contradict is re-asked once, with the batch shown back", async () => {
    queuedAnswers.push(
      { findings: [answer("no-such-block")] },
      { findings: [answer("target-block")] },
    );

    const result = await grade();

    expect(capturedGenerateOptions).toHaveLength(2);
    const repair = capturedGenerateOptions.at(1)?.messages ?? [];
    expect(repair.map(({ role }) => role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(repair.at(0)).toEqual(capturedGenerateOptions.at(0)?.messages.at(0));
    expect(repair.at(1)?.content).toContain("no-such-block");
    expect(repair.at(2)?.content).toContain(`positionId=${POSITION_ID}`);
    expect(repair.at(2)?.content).toContain("cites no-such-block");
    expect(
      Result.isOk(result) ? result.value.get(POSITION_ID)?.citations : null,
    ).toEqual([{ blockId: "target-block", text: "Alpha term" }]);
  });

  test("an answer that still fails after repair is dropped, not re-asked", async () => {
    queuedAnswers.push(
      { findings: [answer("no-such-block")] },
      { findings: [answer("no-such-block")] },
    );

    const result = await grade();

    expect(capturedGenerateOptions).toHaveLength(2);
    expect(
      Result.isOk(result) ? result.value.get(POSITION_ID)?.explanation : null,
    ).toEqual({ type: "insufficient-evidence" });
  });

  test("reports a provider failure under the reference review feature", async () => {
    generateObjectMock.mockRejectedValueOnce(new Error("provider refused"));

    const result = await grade();

    expect(Result.isError(result)).toBe(true);
    expect(
      analytics.events
        .filter(
          (event) => event.event === SERVER_ANALYTICS_EVENTS.aiGenerationFailed,
        )
        .map((event) => event.properties),
    ).toMatchObject([
      { failure_reason: "provider", feature: "document-review.references" },
    ]);
    expect(
      analytics.exceptions().map((event) => event.properties),
    ).toMatchObject([
      { "error.class": "Error", feature: "document-review.references" },
    ]);
  });
});
