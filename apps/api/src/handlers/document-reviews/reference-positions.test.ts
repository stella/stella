import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { SERVER_ANALYTICS_EVENTS } from "@/api/lib/analytics/server-analytics";
import type { AIUsageMetering } from "@/api/lib/analytics/tanstack-ai";
import { toSafeId } from "@/api/lib/branded-types";
import {
  DocumentTooLargeError,
  type WorkflowIntegrationError,
} from "@/api/lib/errors/tagged-errors";
import type { ModelDispatchAdmission } from "@/api/lib/rate-limit/model-dispatch-admission";
import type { PreparedDocxFile } from "@/api/lib/workflow/generate-batch";
import { requestBudgetBytesForTask } from "@/api/lib/workflow/request-budget";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import type {
  RecordingAnalytics,
  RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  openReferenceProposalStream,
  proposeReferencePositions,
} from "./reference-positions";
import type { ProposeReferencePositionsArgs } from "./reference-positions";

const ORGANIZATION_ID = toSafeId<"organization">("org_test");
const MODEL_TIER = "standard";

const budgetBytes = requestBudgetBytesForTask("pdf", null, {
  dataClass: "customer",
  organizationId: ORGANIZATION_ID,
  modelTier: MODEL_TIER,
});

/** Four blocks each the size of the whole budget: fitting them would withhold
 *  three quarters of the text, past the share the fit will accept. */
const oversizedDocument = (name: string): PreparedDocxFile => ({
  kind: "docx",
  fileFieldId: toSafeId<"field">(`field-${name}`),
  fileId: `file-${name}`,
  simplifiedName: name,
  blocks: Array.from({ length: 4 }, (_, index) => ({
    id: `${name}-${String(index)}`,
    kind: "paragraph",
    statedNumbering: { kind: "inherit" },
    text: "y".repeat(budgetBytes),
  })),
});

const oversizedProposal: ProposeReferencePositionsArgs = {
  target: oversizedDocument("F0"),
  references: [
    {
      workspaceId: toSafeId<"workspace">("workspace_test"),
      entityId: toSafeId<"entity">("entity_reference"),
      entityVersionId: toSafeId<"entityVersion">("version_reference"),
      file: oversizedDocument("F1"),
    },
  ],
  seededPositions: [],
  perspective: { type: "neutral" },
  targetEntityVersionId: toSafeId<"entityVersion">("version_target"),
  organizationId: ORGANIZATION_ID,
  admission: asTestRaw<ModelDispatchAdmission>({
    modelTier: MODEL_TIER,
    userId: toSafeId<"user">("user_test"),
  }),
  workspaceId: toSafeId<"workspace">("workspace_test"),
  orgAIConfig: null,
  managedAIResidency: "eu",
  promptCachingEnabled: false,
  serviceTier: "standard",
  usageMetering: asTestRaw<AIUsageMetering>({}),
  abortSignal: new AbortController().signal,
  positionsMax: 10,
};

const refusalOf = (result: Result<unknown, WorkflowIntegrationError>) =>
  Result.isError(result) ? result.error : null;

describe("a proposal whose documents cannot fit the model", () => {
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

  test.each([
    [
      "streaming",
      async () =>
        await Promise.resolve(
          refusalOf(openReferenceProposalStream(oversizedProposal)),
        ),
    ],
    [
      "blocking",
      async () => refusalOf(await proposeReferencePositions(oversizedProposal)),
    ],
  ] as const)(
    "the %s path refuses it and records a refusal, not a generation",
    async (_, propose) => {
      const refusal = await propose();

      expect(DocumentTooLargeError.is(refusal?.cause)).toBe(true);
      expect(analytics.events.map((event) => event.event)).toEqual([
        SERVER_ANALYTICS_EVENTS.aiGenerationFailed,
      ]);
      expect(analytics.events.at(0)?.properties).toMatchObject({
        failure_reason: "validation",
        error_type: "DocumentTooLargeError",
        feature: "document-review.positions",
      });
      expect(logs.at("ERROR")).toEqual([]);
    },
  );
});
