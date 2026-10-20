import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import { createSafeId } from "@/api/lib/branded-types";
import type { writeOrganizationFile } from "@/api/lib/files/organization-file-usage";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  matchesFolioCollabSnapshotCut,
  writeFolioCollabCheckpointObject,
} from "./checkpoint-folio-collab-room";

describe("folio collaboration checkpoint snapshot cut", () => {
  const materialized = {
    baseVersionId: createSafeId<"entityVersion">(),
    generation: 3,
    snapshotFileId: createSafeId<"userFile">(),
    snapshotRevision: 11,
    snapshotUpdatedAt: new Date("2026-08-29T08:00:00.000Z"),
  };

  test("accepts only the snapshot and base version that were materialized", () => {
    expect(
      matchesFolioCollabSnapshotCut({ current: materialized, materialized }),
    ).toBeTrue();
    expect(
      matchesFolioCollabSnapshotCut({
        current: {
          ...materialized,
          snapshotFileId: createSafeId<"userFile">(),
        },
        materialized,
      }),
    ).toBeFalse();
    expect(
      matchesFolioCollabSnapshotCut({
        current: {
          ...materialized,
          baseVersionId: createSafeId<"entityVersion">(),
        },
        materialized,
      }),
    ).toBeFalse();
    expect(
      matchesFolioCollabSnapshotCut({
        current: {
          ...materialized,
          snapshotRevision: 12,
        },
        materialized,
      }),
    ).toBeFalse();
    expect(
      matchesFolioCollabSnapshotCut({
        current: {
          ...materialized,
          snapshotUpdatedAt: new Date("2026-08-29T08:00:01.000Z"),
        },
        materialized,
      }),
    ).toBeFalse();
  });
});

describe("folio collaboration checkpoint storage", () => {
  test.each([
    ["capacity_exceeded", 413],
    ["key_conflict", 409],
  ] as const)(
    "keeps the %s ledger refusal status instead of a server error",
    async (reservationStatus, expectedStatus) => {
      // The ledger answers the reservation itself, so no object is written.
      const fileUsageDb = asTestRaw<
        NonNullable<Parameters<typeof writeOrganizationFile>[0]["db"]>
      >({ transaction: async () => ({ status: reservationStatus }) });
      const priorFlag = env.FEATURE_FILE_USAGE_LIMITS;
      const priorWorkerFlag =
        envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS;
      env.FEATURE_FILE_USAGE_LIMITS = true;
      envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS = true;
      try {
        const written = await writeFolioCollabCheckpointObject({
          ownership: { type: "fixture" },
          checkpointBytes: new Uint8Array([1, 2, 3]),
          checkpointKey: "organization/workspace/files/checkpoint.docx",
          fileUsageDb,
          organizationId: mintAuthProviderId<"organization">(),
        });

        if (Result.isOk(written)) {
          panic("Expected the ledger to refuse the checkpoint");
        }
        expect(written.error).toMatchObject({ status: expectedStatus });
      } finally {
        env.FEATURE_FILE_USAGE_LIMITS = priorFlag;
        envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS = priorWorkerFlag;
      }
    },
  );
});
