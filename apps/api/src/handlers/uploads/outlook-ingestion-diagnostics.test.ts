import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";

import { outlookIngestionDiagnosticSchema } from "@/api/handlers/uploads/outlook-ingestion-diagnostics";

const diagnostic = {
  aggregateAttachmentBytes: 4096,
  attachmentCount: 2,
  host: "Outlook",
  hostVersion: "16.0",
  mailboxRequirementSetSupported: true,
  outcome: "in_progress",
  platform: "PC",
  retryStage: "upload",
  traceId: "0198a6fd-c345-7654-8123-123456789abc",
} as const;

describe("Outlook ingestion diagnostic boundary", () => {
  test("accepts the metadata allowlist", () => {
    expect(Value.Check(outlookIngestionDiagnosticSchema, diagnostic)).toBe(
      true,
    );
  });

  test("rejects content-bearing or identifying fields", () => {
    for (const forbidden of [
      "attachmentContent",
      "attachmentId",
      "body",
      "emailAddress",
      "filename",
      "itemId",
      "subject",
    ]) {
      expect(
        Value.Check(outlookIngestionDiagnosticSchema, {
          ...diagnostic,
          [forbidden]: "privileged content",
        }),
        `accepted forbidden field ${forbidden}`,
      ).toBe(false);
    }
  });

  test("rejects arbitrary runtime labels that could carry client data", () => {
    expect(
      Value.Check(outlookIngestionDiagnosticSchema, {
        ...diagnostic,
        host: "Client legal team",
      }),
    ).toBe(false);
    expect(
      Value.Check(outlookIngestionDiagnosticSchema, {
        ...diagnostic,
        platform: "customer@example.test",
      }),
    ).toBe(false);
    expect(
      Value.Check(outlookIngestionDiagnosticSchema, {
        ...diagnostic,
        hostVersion: "16.0-customer@example.test",
      }),
    ).toBe(false);
  });
});
