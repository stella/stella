/**
 * The model-dispatch boundary of reference grading: what tenant scope reaches
 * model ingress, and what a provider failure reports. The derivation itself is
 * covered by `reference-grade.test.ts`.
 */

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

type CapturedGenerateOptions = {
  tenantWorkspaceIds: readonly SafeId<"workspace">[];
};

const capturedGenerateOptions: CapturedGenerateOptions[] = [];
const generateObjectMock = mock(async (options: CapturedGenerateOptions) => {
  capturedGenerateOptions.push(options);
  return await Promise.resolve({ findings: [] });
});
// SAFETY: This suite only dispatches the reference-grading schema and
// configures outputs matching that schema; Bun's mock type cannot express that
// generic tie.
const generateObjectForTest =
  generateObjectMock as typeof generateTanStackObjectForRole;

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
        sourceId: "11111111-1111-4111-8111-111111111111",
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
    analytics = installRecordingAnalytics();
    logs = installRecordingLogger();
  });

  afterEach(() => {
    analytics.restore();
    logs.restore();
  });

  test("passes the authorized workspace scope to model ingress", async () => {
    capturedGenerateOptions.length = 0;

    const result = await grade();

    expect(Result.isOk(result)).toBe(true);
    expect(capturedGenerateOptions.at(0)?.tenantWorkspaceIds).toEqual([
      workspaceId,
    ]);
    expect(analytics.exceptions()).toEqual([]);
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
