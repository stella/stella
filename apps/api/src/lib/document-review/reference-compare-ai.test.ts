import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import type { AIUsageMetering } from "@/api/lib/analytics/tanstack-ai";
import { SERVER_ANALYTICS_EVENTS } from "@/api/lib/analytics/types";
import { toSafeId, type SafeId } from "@/api/lib/branded-types";
import { NEUTRAL_PERSPECTIVE } from "@/api/lib/document-review/contract";
import { compareReferenceDocuments } from "@/api/lib/document-review/reference-compare";
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
// SAFETY: This suite only dispatches the reference-review schema and configures
// outputs matching that schema; Bun's mock type cannot express that generic tie.
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

const compare = async () =>
  await compareReferenceDocuments({
    perspective: NEUTRAL_PERSPECTIVE,
    target: {
      kind: "docx",
      fileFieldId: targetFieldId,
      fileId: "target-file-fixture",
      simplifiedName: "F0",
      blocks: [{ id: "target-block", kind: "paragraph", text: "Alpha term" }],
    },
    references: [
      {
        kind: "docx",
        fileFieldId: referenceFieldId,
        fileId: "reference-file-fixture",
        simplifiedName: "F1",
        blocks: [
          { id: "reference-block", kind: "paragraph", text: "Beta term" },
        ],
      },
    ],
    topics: [
      {
        type: "custom",
        topicId: "11111111-1111-4111-8111-111111111111",
        title: "Payment timing",
        context: "Compare timing mechanics.",
        included: true,
      },
    ],
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

describe("reference review AI boundary", () => {
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

    const result = await compare();

    expect(Result.isOk(result)).toBe(true);
    expect(capturedGenerateOptions.at(0)?.tenantWorkspaceIds).toEqual([
      workspaceId,
    ]);
    expect(analytics.exceptions()).toEqual([]);
  });

  test("reports a provider failure under the reference review feature", async () => {
    generateObjectMock.mockRejectedValueOnce(new Error("provider refused"));

    const result = await compare();

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
