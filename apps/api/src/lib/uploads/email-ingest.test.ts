import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import type { EmailIngestPostCommitKickoff } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import {
  persistEmailIngestRecoveryKeys,
  scheduleEmailIngestPostCommitWork,
} from "@/api/lib/uploads/email-ingest";
import {
  detectEmailContainer,
  emailIngestFinalObjectCleanupFailure,
  resolveStoredEmailFileName,
  validateEmailAttachmentCount,
  validateEmailAttachmentMimeType,
  validateEmailIngestContainer,
} from "@/api/lib/uploads/email-ingest-policy";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const pendingUploadId = toSafeId<"pendingUpload">(
  "00000000-0000-0000-0000-000000000001",
);
const userId = toSafeId<"user">("00000000-0000-0000-0000-000000000002");
const workspaceId = toSafeId<"workspace">(
  "00000000-0000-0000-0000-000000000003",
);
const propertyId = toSafeId<"property">("00000000-0000-0000-0000-000000000004");
const emailIngestSource = await Bun.file(
  new URL("email-ingest.ts", import.meta.url),
).text();

describe("validateEmailAttachmentCount", () => {
  test("accepts the bounded maximum", () => {
    expect(Result.isOk(validateEmailAttachmentCount(50))).toBe(true);
  });

  test("rejects instead of truncating excess attachments", () => {
    const result = validateEmailAttachmentCount(51);

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.status).toBe(422);
      expect(result.error.rejectReason).toBe("too-many-attachments");
    }
  });
});

test("classifies final-object cleanup failure as retryable", () => {
  const error = emailIngestFinalObjectCleanupFailure();

  expect(error.status).toBe(500);
  expect(error.rejectReason).toBe("final-object-cleanup-failed");
});

test("renews the finalize lease atomically with email recovery keys", async () => {
  const writes: unknown[] = [];
  const tx = asTestRaw<Transaction>({
    update: () => ({
      set: (values: unknown) => {
        writes.push(values);
        return {
          where: () => ({
            returning: async () => [{ id: pendingUploadId }],
          }),
        };
      },
    }),
  });
  const safeDb = asTestRaw<SafeDb>(
    async <T>(run: (transaction: Transaction) => Promise<T>) =>
      Result.ok(await run(tx)),
  );

  const result = await persistEmailIngestRecoveryKeys({
    safeDb,
    uploadId: pendingUploadId,
    userId,
    workspaceId,
    claimRequestId: "claim-1",
    purposeData: { type: "email_ingest", propertyId },
    recoveryObjectKeys: ["org/workspace/message.eml"],
  });

  expect(Result.isOk(result)).toBe(true);
  expect(writes).toEqual([
    {
      claimedAt: expect.any(Date),
      purposeData: {
        type: "email_ingest",
        propertyId,
        recoveryObjectKeys: ["org/workspace/message.eml"],
      },
    },
  ]);
});

test("preserves final objects after the transaction prepares durable references", () => {
  const durableReference = emailIngestSource.indexOf(
    'transactionState.status = "durable_reference_prepared"',
  );
  const writeFailure = emailIngestSource.indexOf(
    "Result.isError(writeResultResult)",
    durableReference,
  );
  const rollbackGuard = emailIngestSource.indexOf(
    'transactionState.status === "pending"',
    writeFailure,
  );
  const objectCleanup = emailIngestSource.indexOf(
    '"final-cleanup-after-db-error"',
    rollbackGuard,
  );

  expect(durableReference).toBeGreaterThan(-1);
  expect(writeFailure).toBeGreaterThan(durableReference);
  expect(rollbackGuard).toBeGreaterThan(writeFailure);
  expect(objectCleanup).toBeGreaterThan(rollbackGuard);
});

test("re-reads durable state and schedules post-commit work after an ambiguous commit", () => {
  const durableReference = emailIngestSource.indexOf(
    'transactionState.status = "durable_reference_prepared"',
  );
  const durableRead = emailIngestSource.indexOf(
    "tx.query.pendingUploads.findFirst",
    durableReference,
  );
  const postCommitReplay = emailIngestSource.indexOf(
    "replayEmailIngestPostCommitWork",
    durableRead,
  );
  const errorPropagation = emailIngestSource.indexOf(
    "yield* writeResultResult",
    durableRead,
  );

  expect(durableRead).toBeGreaterThan(durableReference);
  expect(postCommitReplay).toBeGreaterThan(durableRead);
  expect(errorPropagation).toBeGreaterThan(postCommitReplay);
});

test("replays every post-commit operation from durable kickoff descriptors", async () => {
  const entityId = toSafeId<"entity">("00000000-0000-0000-0000-000000000005");
  const fieldId = toSafeId<"field">("00000000-0000-0000-0000-000000000006");
  const organizationId = toSafeId<"organization">(
    "00000000-0000-0000-0000-000000000007",
  );
  const kickoffs = [
    {
      encrypted: false,
      entityId,
      fieldId,
      sourceUploadId: pendingUploadId,
      fileName: "message.eml",
      mimeType: "message/rfc822",
    },
  ] satisfies EmailIngestPostCommitKickoff[];
  const calls: string[] = [];

  scheduleEmailIngestPostCommitWork({
    kickoffs,
    organizationId,
    userId,
    workspaceId,
    operations: {
      processExtraction: async () => {
        calls.push("extract");
      },
      maybeStartUploadTriggeredFlows: async () => {
        calls.push("flow");
      },
      enqueuePdfDerivativeOrMarkFailed: async () => {
        calls.push("pdf");
      },
      enqueueImageThumbnailOrMarkFailed: async () => {
        calls.push("thumbnail");
      },
    },
  });
  await Promise.resolve();

  expect(calls).toEqual(["extract", "flow", "pdf", "thumbnail"]);
});

describe("email attachment policy", () => {
  test("rejects nested email containers", () => {
    for (const mimeType of ["message/rfc822", "application/vnd.ms-outlook"]) {
      const result = validateEmailAttachmentMimeType(
        new Uint8Array(),
        mimeType,
      );
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error.rejectReason).toBe("nested-email-attachment");
      }
    }
  });

  test("detects nested EML content despite generic metadata", () => {
    const bytes = new TextEncoder().encode(
      "From: sender@example.com\r\nSubject: nested\r\n\r\nbody",
    );

    expect(detectEmailContainer(bytes)).toBe("eml");
    expect(
      Result.isError(
        validateEmailAttachmentMimeType(bytes, "application/octet-stream"),
      ),
    ).toBe(true);
    expect(
      Result.isOk(validateEmailIngestContainer(bytes, "message/rfc822")),
    ).toBe(true);
  });

  test("detects an EML header when a large field pushes the separator past the sample", () => {
    const bytes = new TextEncoder().encode(
      `From: sender@example.com\r\nSubject: ${"x".repeat(70_000)}\r\n\r\nbody`,
    );

    expect(detectEmailContainer(bytes)).toBe("eml");
    const result = validateEmailAttachmentMimeType(
      bytes,
      "application/octet-stream",
    );
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.rejectReason).toBe("nested-email-attachment");
    }
  });

  test("rejects an email container that differs from its declared MIME", () => {
    const bytes = new TextEncoder().encode(
      "From: sender@example.com\r\nSubject: mismatch\r\n\r\nbody",
    );
    const result = validateEmailIngestContainer(
      bytes,
      "application/vnd.ms-outlook",
    );

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.rejectReason).toBe("email-container-mismatch");
    }
  });

  test("preserves the source email extension in stored file metadata", () => {
    expect(
      String(resolveStoredEmailFileName("SPA review", "message/rfc822")),
    ).toBe("SPA review.eml");
    expect(
      String(
        resolveStoredEmailFileName(
          "Matter update.msg",
          "application/vnd.ms-outlook",
        ),
      ),
    ).toBe("Matter update.msg");
  });
});
