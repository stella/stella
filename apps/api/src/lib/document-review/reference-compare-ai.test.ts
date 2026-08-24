import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import type { AIUsageMetering } from "@/api/lib/analytics/tanstack-ai";
import { toSafeId, type SafeId } from "@/api/lib/branded-types";
import { NEUTRAL_PERSPECTIVE } from "@/api/lib/document-review/contract";

type CapturedGenerateOptions = {
  tenantWorkspaceIds: readonly SafeId<"workspace">[];
};

const capturedGenerateOptions: CapturedGenerateOptions[] = [];
const generateObjectMock = mock(async (options: CapturedGenerateOptions) => {
  capturedGenerateOptions.push(options);
  return await Promise.resolve({ findings: [] });
});

const realTanstackAIGenerate = await import("@/api/lib/tanstack-ai-generate");
void mock.module("@/api/lib/tanstack-ai-generate", () => ({
  ...realTanstackAIGenerate,
  generateTanStackObjectForRole: generateObjectMock,
}));

const realTanstackAIAnalytics = await import("@/api/lib/analytics/tanstack-ai");
void mock.module("@/api/lib/analytics/tanstack-ai", () => ({
  ...realTanstackAIAnalytics,
  createTanStackAIAnalyticsCallbacks: () => ({
    middleware: {},
    captureError: mock((_error: unknown) => undefined),
  }),
}));

const { compareReferenceDocuments } =
  await import("@/api/lib/document-review/reference-compare");

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

describe("reference review AI boundary", () => {
  test("passes the authorized workspace scope to model ingress", async () => {
    capturedGenerateOptions.length = 0;

    const result = await compareReferenceDocuments({
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
      targetEntityVersionId: toSafeId<"entityVersion">(
        "target-version-fixture",
      ),
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
    });

    expect(Result.isOk(result)).toBe(true);
    expect(capturedGenerateOptions.at(0)?.tenantWorkspaceIds).toEqual([
      workspaceId,
    ]);
  });
});
