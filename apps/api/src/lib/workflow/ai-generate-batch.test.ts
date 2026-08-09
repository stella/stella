import { describe, expect, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import type { AIUsageMetering } from "@/api/lib/analytics/tanstack-ai";
import { toSafeId } from "@/api/lib/branded-types";
import {
  buildWorkflowAIAnalyticsProps,
  EXTRACTED_TEXT_PROMPT_LIMITS,
  limitExtractedTextPromptContent,
} from "@/api/lib/workflow/ai-generate-batch";

const organizationId = toSafeId<"organization">("organization-1");
const userId = toSafeId<"user">("user-1");
const workspaceId = toSafeId<"workspace">("workspace-1");

describe("buildWorkflowAIAnalyticsProps", () => {
  test("threads workflow usage metering into AI analytics props", () => {
    const safeDb: SafeDb = async () => {
      throw new Error("safeDb should not be called by this test");
    };
    const usageMetering = {
      actionType: "background",
      organizationId,
      safeDb,
      serviceTier: "flex",
      userId,
      workspaceId,
    } satisfies AIUsageMetering;

    const props = buildWorkflowAIAnalyticsProps({
      entityVersionId: "entity-version-1",
      organizationId,
      orgAIConfig: null,
      propertyCount: 2,
      usageMetering,
      workspaceId,
    });

    expect(props).toMatchObject({
      feature: "workflow.generate-batch",
      modelRole: "pdf",
      properties: {
        entity_version_id: "entity-version-1",
        organization_id: organizationId,
        property_count: 2,
        workspace_id: workspaceId,
      },
      sessionId: "entity-version-1",
      usageMetering,
    });
  });
});

describe("extracted-text prompt limits", () => {
  test("enforces per-file and aggregate bounds with visible truncation", () => {
    const contents = [
      "a".repeat(80_000),
      "b".repeat(80_000),
      "c".repeat(80_000),
    ];
    const limited = contents.map((content) =>
      limitExtractedTextPromptContent({
        content,
        fileCount: contents.length,
      }),
    );

    expect(
      limited.every(
        (content) =>
          content.length <= EXTRACTED_TEXT_PROMPT_LIMITS.perFileChars,
      ),
    ).toBe(true);
    expect(
      limited.reduce((total, content) => total + content.length, 0),
    ).toBeLessThanOrEqual(EXTRACTED_TEXT_PROMPT_LIMITS.totalChars);
    expect(limited.every((content) => content.includes("truncated"))).toBe(
      true,
    );
  });
});
