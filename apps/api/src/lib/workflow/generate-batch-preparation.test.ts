import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ScopedDb } from "@/api/db/safe-db";
import type { FieldContent } from "@/api/db/schema-validators";
import { envBase } from "@/api/env-base";
import { toSafeId } from "@/api/lib/branded-types";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";
import { createFileKey } from "@/api/lib/files/utils";
import { isMissingCorpusObjectError } from "@/api/lib/s3";
import { buildWorkflowFileMessages } from "@/api/lib/workflow/ai-generate-batch";
import {
  buildJustificationFilenames,
  fetchAndPrepareFiles,
  generateBatch,
} from "@/api/lib/workflow/generate-batch";
import type {
  GenerateBatchProps,
  ResolvedFile,
} from "@/api/lib/workflow/generate-batch-shared";
import type { AIBatchProperty } from "@/api/lib/workflow/get-execution-plan";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
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

const dependencies = {
  fetchInputFieldsForBatch: async () => [
    { id: fileFieldId, propertyId, content: fileContent },
  ],
};

// The object the PDF path reaches for: the input file's own id under the
// organization and workspace the batch runs in.
const inputObjectKey = `org_test/workspace_test/${fileContent.id}.pdf`;

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
  let fake: FakeS3;

  beforeEach(() => {
    fake = startFakeS3();
  });

  afterEach(() => {
    fake.stop();
  });

  test("reports an unreadable input file as an integration failure instead of rejecting", async () => {
    // The rejection is bound to the key the preparation must ask for: a read
    // of any other key finds no object and fails as an absent object instead.
    fake.failNext({
      method: "GET",
      code: "AccessDenied",
      status: 403,
      key: inputObjectKey,
    });

    const result = await generateBatch(props, dependencies);

    expect(Result.isError(result)).toBe(true);
    if (!Result.isError(result)) {
      return;
    }

    // The declared error union is what the caller retries on and maps to a
    // gateway status; a rejection would bypass both.
    expect(WorkflowIntegrationError.is(result.error)).toBe(true);
    const cause = result.error.cause;
    // A denial is not an absence: the batch must not conclude the input file
    // is gone when the store merely refused the read.
    expect(isMissingCorpusObjectError(cause)).toBe(false);
    expect(cause instanceof Error ? cause.message : "").toBe(
      `Object read for ${inputObjectKey} failed with 403`,
    );
    expect(
      fake.requests
        .filter(({ method }) => method === "GET")
        .map(({ key }) => key),
    ).toEqual([inputObjectKey]);
  });

  test("passes native HEIC and HEIF bytes from the scoped object through image messages without PDF citations", async () => {
    for (const mimeType of ["image/heic", "image/heif"] as const) {
      // Deliberately not a decodable image: this path must forward bytes,
      // never invoke the local codec or PDF parser.
      const bytes = new Uint8Array([0, 255, 1, 128, 42]);
      const file = {
        fileFieldId,
        fileId: fileContent.id,
        mimeType,
        encrypted: false,
        pdfFileId: null,
        sha256Hex: fileContent.sha256Hex,
      } satisfies ResolvedFile;
      const key = createFileKey({
        organizationId: props.organizationId,
        workspaceId: props.workspaceId,
        fileId: file.fileId,
        mimeType,
      });
      fake.put(envBase.S3_BUCKET, key, bytes, mimeType);
      const prepared = await fetchAndPrepareFiles(
        [file],
        props.organizationId,
        props.workspaceId,
      );
      expect(prepared).toEqual([
        {
          kind: "native-image",
          fileFieldId,
          fileId: file.fileId,
          content: bytes,
          mimeType,
          simplifiedName: "F0",
        },
      ]);
      const messages = buildWorkflowFileMessages(prepared);
      expect(messages.filter((part) => part.type === "image")).toEqual([
        {
          type: "image",
          source: {
            type: "data",
            value: Buffer.from(bytes).toString("base64"),
            mimeType,
          },
        },
      ]);
      expect(messages.some((part) => part.type === "document")).toBe(false);
      expect(buildJustificationFilenames(prepared)).toEqual([]);
      expect(fake.requests.at(-1)?.key).toBe(key);
    }
  });

  test("rejects HEIC for an unsupported provider before reading storage", async () => {
    const result = await generateBatch(props, {
      fetchInputFieldsForBatch: async () => [
        {
          id: fileFieldId,
          propertyId,
          content: {
            ...fileContent,
            mimeType: "image/heic",
            fileName: "scan.heic",
          },
        },
      ],
      isNativeImageSupported: () => false,
      getTextModelInfo: () => ({
        provider: "openai",
        modelId: "gpt-5.4",
        keySource: "instance",
      }),
    });
    expect(result.unwrap()).toEqual({
      aiResults: [],
      aiJustifications: [],
      skippedPropertyIds: [],
      unsupportedPropertyIds: [propertyId],
    });
    expect(fake.requests).toEqual([]);
  });

  test("accepts HEIC for Gemini and reports storage failures through the retryable error path", async () => {
    const imageKey = createFileKey({
      organizationId: props.organizationId,
      workspaceId: props.workspaceId,
      fileId: fileContent.id,
      mimeType: "image/heic",
    });
    fake.failNext({
      method: "GET",
      code: "AccessDenied",
      status: 403,
      key: imageKey,
    });
    const result = await generateBatch(props, {
      fetchInputFieldsForBatch: async () => [
        {
          id: fileFieldId,
          propertyId,
          content: {
            ...fileContent,
            mimeType: "image/heic",
            fileName: "scan.heic",
          },
        },
      ],
      isNativeImageSupported: () => true,
      getTextModelInfo: () => ({
        provider: "google",
        modelId: "gemini-3.5-flash",
        keySource: "instance",
      }),
    });
    expect(Result.isError(result)).toBe(true);
    if (!Result.isError(result)) {
      return;
    }
    expect(WorkflowIntegrationError.is(result.error)).toBe(true);
    const cause = result.error.cause;
    expect(cause instanceof Error ? cause.message : "").toBe(
      `Object read for ${imageKey} failed with 403`,
    );
    expect(
      fake.requests
        .filter(({ method }) => method === "GET")
        .map(({ key }) => key),
    ).toEqual([imageKey]);
  });

  test("rejects encrypted HEIC without resolving a model or reading storage", async () => {
    const result = await generateBatch(props, {
      fetchInputFieldsForBatch: async () => [
        {
          id: fileFieldId,
          propertyId,
          content: {
            ...fileContent,
            mimeType: "image/heic",
            fileName: "scan.heic",
            encrypted: true,
          },
        },
      ],
      getTextModelInfo: () => {
        throw new Error("Encrypted input must not reach model resolution");
      },
      isNativeImageSupported: () => true,
    });
    expect(result.unwrap().unsupportedPropertyIds).toEqual([propertyId]);
    expect(fake.requests).toEqual([]);
  });
});
