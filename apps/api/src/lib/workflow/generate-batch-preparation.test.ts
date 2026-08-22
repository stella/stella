import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import type { ScopedDb } from "@/api/db/safe-db";
import type { FieldContent } from "@/api/db/schema-validators";
import { toSafeId } from "@/api/lib/branded-types";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";
import type { GenerateBatchProps } from "@/api/lib/workflow/generate-batch-shared";
import type { AIBatchProperty } from "@/api/lib/workflow/get-execution-plan";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const fileFieldId = toSafeId<"field">("field_file");
const propertyId = toSafeId<"property">("property_extract");

const fileContent = {
  version: 1,
  type: "file",
  id: "00000000-0000-4000-8000-000000000001",
  fileName: "contract.pdf",
  mimeType: "application/pdf",
  sizeBytes: 1024,
  encrypted: false,
  sha256Hex: "a".repeat(64),
  pdfFileId: null,
} as const satisfies FieldContent;

const realShared = await import("@/api/lib/workflow/generate-batch-shared");

void mock.module("@/api/lib/workflow/generate-batch-shared", () => ({
  ...realShared,
  fetchInputFieldsForBatch: async () => [
    { id: fileFieldId, propertyId, content: fileContent },
  ],
}));

// The failure under test: every path in `fetchAndPrepareFiles` reaches S3
// before it can produce a prepared file.
const readFailure = new Error("object read failed");
const realS3 = await import("@/api/lib/s3");

void mock.module("@/api/lib/s3", () => ({
  ...realS3,
  readS3ArrayBuffer: async () => {
    throw readFailure;
  },
}));

const { generateBatch } = await import("@/api/lib/workflow/generate-batch");

const aiProperty = {
  id: propertyId,
  status: "stale",
  content: { version: 1, type: "text" },
  dependencies: [],
  tool: { version: 1, type: "ai-model", prompt: "Extract the parties." },
} as const satisfies AIBatchProperty;

const props = {
  abortSignal: new AbortController().signal,
  batch: { id: "batch_0", inputs: [propertyId], properties: [aiProperty] },
  entityVersionId: toSafeId<"entityVersion">("entity_version_test"),
  organizationId: toSafeId<"organization">("org_test"),
  workspaceId: toSafeId<"workspace">("workspace_test"),
  scopedDb: asTestRaw<ScopedDb>(async () => {
    throw new Error("unexpected database access");
  }),
  orgAIConfig: null,
  promptCachingEnabled: false,
  serviceTier: "standard",
} as const satisfies GenerateBatchProps;

describe("workflow batch input preparation", () => {
  test("reports an unreadable input file as an integration failure instead of rejecting", async () => {
    const result = await generateBatch(props);

    expect(Result.isError(result)).toBe(true);
    if (!Result.isError(result)) {
      return;
    }

    // The declared error union is what the caller retries on and maps to a
    // gateway status; a rejection would bypass both.
    expect(WorkflowIntegrationError.is(result.error)).toBe(true);
    expect(result.error.cause).toBe(readFailure);
  });
});
