import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { FieldContent } from "@/api/db/schema-validators";
import { toSafeId } from "@/api/lib/branded-types";
import { createIdleExitCheck } from "@/api/lib/document-processing-idle-exit";
import {
  abortDocumentProcessingWorkerBeforeClose,
  createDocumentProcessingLeaseRenewal,
  DOCUMENT_PROCESSING_RECONCILIATION_PHASE_FEEDS,
  DOCUMENT_PROCESSING_RECONCILIATION_PHASES,
  indexDocumentProjectionAtJobBoundary,
  readRepairScanCursor,
  RECONCILE_BATCH_SIZE,
  reconciliationLeftWorkBehind,
  resolveRepairScanPage,
  resolveScheduledDeliveryBatch,
  resolveSearchIndexReplayBatch,
  runDocumentProcessingReconciliationPhases,
  runSearchIndexReplayAttempt,
  tryEnqueueDocumentProcessingRun,
  writeRepairScanCursor,
} from "@/api/lib/document-processing-queue";
import {
  automaticOcrRetryDelayMs,
  DOCUMENT_PROCESSING_FAILURE_REPORT,
  documentProcessingFailureReport,
  DocumentProcessingRunSettledError,
  isRetryableAutomaticOcrFailure,
  isRetryableOcrDerivativeFailure,
  isRetryableSearchIndexFailure,
  settleDocumentProcessingAttemptError,
} from "@/api/lib/document-processing-queue-attempt";
import {
  classifyOcrProjectionSource,
  classifyOcrWorkspaceDispatch,
  DocumentProcessingJobError,
  indexDocumentProjection,
  isCurrentNativeExtractionSource,
  isCurrentOcrSource,
  isPreservableAutomaticProjection,
  ownsPromotedManualOcrClaim,
  requiresOcrPolicy,
  shouldFailStaleAutomaticOcrRun,
  shouldPreserveCurrentProjection,
} from "@/api/lib/document-processing-queue-policy";
import { createReconciliationProgress } from "@/api/lib/document-processing-reconciliation-progress";
import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import { isTransientRedisConnectionError } from "@/api/lib/redis-error-classification";

const queueSource = await Bun.file(
  new URL("document-processing-queue.ts", import.meta.url),
).text();
const enqueueSource = await Bun.file(
  new URL("document-processing-enqueue.ts", import.meta.url),
).text();

const fileContent = {
  type: "file",
  version: 1,
  id: "019864b8-48d0-7f37-94d5-948e3bcf3f44",
  fileName: "rozsudek.pdf",
  mimeType: "application/pdf",
  sizeBytes: 123,
  sha256Hex: "a".repeat(64),
  encrypted: false,
  pdfFileId: null,
} satisfies FieldContent;

const run = {
  entityVersionId: toSafeId<"entityVersion">(
    "019864b8-48d0-7f37-94d5-948e3bcf3f45",
  ),
  fieldId: toSafeId<"field">("019864b8-48d0-7f37-94d5-948e3bcf3f46"),
  sourceFileId: fileContent.id,
  sourceSha256Hex: fileContent.sha256Hex,
};

const workspaceId = toSafeId<"workspace">(
  "019864b8-48d0-7f37-94d5-948e3bcf3f47",
);

const selectedFileContent = {
  ...fileContent,
  id: "019864b8-48d0-7f37-94d5-948e3bcf3f48",
  fileName: "smlouva.docx",
  mimeType:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  sha256Hex: "b".repeat(64),
} satisfies FieldContent;

const selectedSourceField = {
  content: selectedFileContent,
  entityVersionId: run.entityVersionId,
  id: toSafeId<"field">("019864b8-48d0-7f37-94d5-948e3bcf3f49"),
  workspaceId,
};

const source = {
  content: fileContent,
  currentVersionId: run.entityVersionId,
  entityReadOnly: false,
  fieldEntityVersionId: run.entityVersionId,
  versionDeletedAt: null,
};

describe("document scout dispatch isolation", () => {
  test("persists pending scout work with source completion before dispatch", () => {
    const completionStart = queueSource.indexOf(
      "const completeDocumentProcessingRun",
    );
    const completionEnd = queueSource.indexOf(
      "\nexport const processDocumentProcessingRun",
      completionStart,
    );
    const completionSource = queueSource.slice(completionStart, completionEnd);
    const durableHandoff = completionSource.indexOf(
      "deadlineScoutStatus: shouldDispatchDeadlineScout",
    );
    const succeededTransition = completionSource.indexOf('status: "succeeded"');
    const completedGuard = completionSource.indexOf(
      "if (!completed.at(0))",
      succeededTransition,
    );
    const scoutDispatch = completionSource.indexOf(
      "await enqueueDocumentDeadlineScout",
      completedGuard,
    );

    expect(completionStart).toBeGreaterThan(-1);
    expect(completionEnd).toBeGreaterThan(completionStart);
    expect(durableHandoff).toBeGreaterThan(-1);
    expect(succeededTransition).toBeGreaterThan(-1);
    expect(succeededTransition).toBeGreaterThan(durableHandoff);
    expect(completedGuard).toBeGreaterThan(succeededTransition);
    expect(scoutDispatch).toBeGreaterThan(completedGuard);
    expect(completionSource).toContain(
      'logger.error("document_processing.deadline_scout_enqueue_failed"',
    );
  });
});

describe("OCR derivative durability", () => {
  // A failed search index leaves a run that `recoverFailedSearchIndex` later
  // completes without revisiting storage. Building the derivative after
  // indexing would let that replay mark a run succeeded whose searchable PDF
  // was never written, so every export of it would 404 forever.
  test("stores the derivative before indexing so index replay cannot skip it", () => {
    const processStart = queueSource.indexOf(
      "export const processDocumentProcessingRun",
    );
    const processEnd = queueSource.indexOf("\nconst errorCode", processStart);
    const processSource = queueSource.slice(processStart, processEnd);
    const persistence = processSource.indexOf(
      "const persistenceOutcome = await persistOcrProjection",
    );
    const derivative = processSource.indexOf(
      "await writeOcrSearchablePdfDerivative",
    );
    const searchIndex = processSource.indexOf(
      "await indexDocumentProjection",
      derivative,
    );

    expect(persistence).toBeGreaterThan(-1);
    expect(derivative).toBeGreaterThan(persistence);
    expect(searchIndex).toBeGreaterThan(derivative);
  });

  // The source read and the derivative write are storage calls that can fail
  // transiently. Outside the derivative stage they would settle as generic
  // `processing_failed`, which manual retries exclude, stranding the
  // projection without its PDF.
  test("classifies the whole derivative stage as a retryable derivative failure", () => {
    const stageStart = queueSource.indexOf(
      "const writeOcrSearchablePdfDerivative",
    );
    const stageEnd = queueSource.indexOf("\nexport const", stageStart);
    const stageSource = queueSource.slice(stageStart, stageEnd);

    expect(stageStart).toBeGreaterThan(-1);
    for (const storageCall of [
      "await readTenantS3ArrayBuffer(",
      "await createOcrSearchablePdf(",
      "await writeTenantS3Object(",
    ]) {
      expect(stageSource).toContain(storageCall);
    }
    expect(stageSource).toContain("code: SEARCHABLE_PDF_FAILURE_CODE");
  });

  test("retries derivative failures within the bounded attempt budget", () => {
    expect(
      isRetryableOcrDerivativeFailure({
        attemptCount: 1,
        errorCode: "searchable_pdf_failed",
      }),
    ).toBe(true);
    expect(
      isRetryableOcrDerivativeFailure({
        attemptCount: 5,
        errorCode: "searchable_pdf_failed",
      }),
    ).toBe(false);
  });
});

describe("lease heartbeat", () => {
  test("reports a deadline without accumulating stalled renewals", async () => {
    let finishRenewal: () => void = () => undefined;
    const stalledRenewal = new Promise<void>((resolve) => {
      finishRenewal = resolve;
    });
    const errors: unknown[] = [];
    let renewalCount = 0;
    const renew = createDocumentProcessingLeaseRenewal({
      onError: (error) => {
        errors.push(error);
      },
      renewLease: async () => {
        renewalCount += 1;
        await stalledRenewal;
      },
      timeoutMs: 5,
    });

    renew();
    renew();
    expect(renewalCount).toBe(1);

    await Bun.sleep(20);
    renew();
    expect(renewalCount).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors.at(0)).toBeInstanceOf(TimeoutError);
    expect(errors.at(0)).toMatchObject({
      label: "document processing lease heartbeat",
      timeoutMs: 5,
    });

    finishRenewal();
    await stalledRenewal;
    await Promise.resolve();
    renew();
    expect(renewalCount).toBe(2);
  });
});

describe("repair cursor Redis deadlines", () => {
  test("bounds a stalled cursor read", async () => {
    const rejection: unknown = await readRepairScanCursor(async () => {
      await Bun.sleep(50);
      return null;
    }, 5).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(TimeoutError);
    expect(rejection).toMatchObject({
      label: "document OCR repair cursor read",
      timeoutMs: 5,
    });
  });

  test("bounds a stalled cursor compare-and-set write", async () => {
    const rejection: unknown = await writeRepairScanCursor({
      expectedCursor: null,
      nextCursor: run.fieldId,
      sendCommand: async () => {
        await Bun.sleep(50);
        return 1;
      },
      timeoutMs: 5,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(TimeoutError);
    expect(rejection).toMatchObject({
      label: "document OCR repair cursor write",
      timeoutMs: 5,
    });
  });
});

describe("reconciliation fault isolation", () => {
  test("dispatches every durable processing kind and repairs native gaps", () => {
    const dispatchStart = queueSource.indexOf(
      "export const dispatchQueuedDocumentProcessingRuns",
    );
    const dispatchEnd = queueSource.indexOf(
      "const dispatchScheduledDocumentProcessingRetries",
      dispatchStart,
    );
    const dispatchSource = queueSource.slice(dispatchStart, dispatchEnd);
    const repairStart = queueSource.indexOf(
      "const recoverMissingNativeExtractionRuns",
    );
    const repairEnd = queueSource.indexOf(
      "const updateQueuedRunSchedule",
      repairStart,
    );
    const repairSource = queueSource.slice(repairStart, repairEnd);

    expect(dispatchStart).toBeGreaterThan(-1);
    expect(dispatchSource).not.toContain(
      'eq(documentProcessingRuns.kind, "ocr")',
    );
    expect(repairStart).toBeGreaterThan(-1);
    expect(repairSource).toContain("persistMissingNativeExtractionRuns");
    expect(repairSource).not.toContain("organizationSettings");
  });

  test("prioritizes never-dispatched OCR runs ahead of visibility retries", () => {
    const dispatchStart = queueSource.indexOf(
      "export const dispatchQueuedDocumentProcessingRuns",
    );
    const dispatchEnd = queueSource.indexOf(
      "const dispatchScheduledDocumentProcessingRetries",
      dispatchStart,
    );
    const dispatchSelection = queueSource.slice(dispatchStart, dispatchEnd);

    expect(dispatchSelection).toContain("ASC NULLS FIRST");
  });

  test("continues later phases after an early phase fails", async () => {
    const calls: string[] = [];
    const failures: { error: unknown; phase: string }[] = [];
    const repairError = new Error("repair unavailable");

    const results = await runDocumentProcessingReconciliationPhases({
      phases: [
        {
          name: "deadline-scout",
          run: async () => {
            calls.push("deadline-scout");
            return { count: 0, hasMore: false };
          },
        },
        {
          name: "delivery",
          run: async () => {
            calls.push("delivery");
            return { count: 5, hasMore: false };
          },
        },
        {
          name: "repair",
          run: async () => {
            calls.push("repair");
            throw repairError;
          },
        },
        {
          name: "reindex",
          run: async () => {
            calls.push("reindex");
            return { count: 2, hasMore: false };
          },
        },
        {
          name: "retry",
          run: async () => {
            calls.push("retry");
            return { count: 3, hasMore: true };
          },
        },
        {
          name: "stale-lease",
          run: async () => {
            calls.push("stale-lease");
            return { count: 4, hasMore: false };
          },
        },
      ],
      onPhaseError: (error, phase) => {
        failures.push({ error, phase });
      },
    });

    expect(calls).toEqual([
      "deadline-scout",
      "delivery",
      "repair",
      "reindex",
      "retry",
      "stale-lease",
    ]);
    expect(failures).toEqual([{ error: repairError, phase: "repair" }]);
    expect(results).toEqual({
      "deadline-scout": { count: 0, hasMore: false },
      delivery: { count: 5, hasMore: false },
      reindex: { count: 2, hasMore: false },
      repair: { count: 0, hasMore: true },
      retry: { count: 3, hasMore: true },
      "stale-lease": { count: 4, hasMore: false },
    });
  });

  test("bounds a stalled BullMQ delivery attempt", async () => {
    const captured: unknown[] = [];
    const result = await tryEnqueueDocumentProcessingRun({
      captureEnqueueError: (error) => {
        captured.push(error);
      },
      enqueue: async () => {
        await Bun.sleep(50);
      },
      runId: toSafeId<"documentProcessingRun">("run_test"),
      timeoutMs: 5,
    });

    expect(result.status).toBe("failed");
    expect(captured).toHaveLength(1);
    expect(captured.at(0)).toBeInstanceOf(TimeoutError);
    expect(captured.at(0)).toMatchObject({
      label: "document OCR queue handoff",
      timeoutMs: 5,
    });
  });

  test("uses fail-fast Redis clients only for producer operations", () => {
    expect(enqueueSource).toContain("enableOfflineQueue: false");
    expect(enqueueSource).toContain(
      "connectionTimeout: QUEUE_OPERATION_TIMEOUT_MS",
    );
    expect(queueSource).toContain("enableOfflineQueue: false");
    expect(queueSource).toContain(
      "connectionTimeout: REPAIR_SCAN_CURSOR_COMMAND_TIMEOUT_MS",
    );
    expect(queueSource).toContain("connection: createBullMqConnection(),");
  });
});

describe("isCurrentOcrSource", () => {
  test("accepts the exact live immutable PDF source", () => {
    expect(isCurrentOcrSource({ run, source })).toBe(true);
  });

  test("rejects a replaced source with the same field", () => {
    expect(
      isCurrentOcrSource({
        run,
        source: {
          ...source,
          content: { ...fileContent, sha256Hex: "b".repeat(64) },
        },
      }),
    ).toBe(false);
  });

  test("rejects a no-longer-current version", () => {
    expect(
      isCurrentOcrSource({
        run,
        source: {
          ...source,
          currentVersionId: toSafeId<"entityVersion">(
            "019864b8-48d0-7f37-94d5-948e3bcf3f47",
          ),
        },
      }),
    ).toBe(false);
  });
});

describe("isCurrentNativeExtractionSource", () => {
  const docxRun = {
    entityVersionId: run.entityVersionId,
    fieldId: selectedSourceField.id,
    sourceFileId: selectedFileContent.id,
    sourceSha256Hex: selectedFileContent.sha256Hex,
  };
  const docxSource = {
    content: selectedFileContent,
    currentVersionId: run.entityVersionId,
    entityReadOnly: false,
    fieldEntityVersionId: run.entityVersionId,
    versionDeletedAt: null,
  };

  test("accepts the exact live immutable DOCX source", () => {
    expect(isCurrentNativeExtractionSource(docxRun, docxSource)).toBe(true);
  });

  test("rejects a replaced DOCX source", () => {
    expect(
      isCurrentNativeExtractionSource(docxRun, {
        ...docxSource,
        content: { ...selectedFileContent, sha256Hex: "c".repeat(64) },
      }),
    ).toBe(false);
  });

  test("rejects every stale or ineligible native source state", () => {
    const rejectionCases = {
      deletedVersion: {
        ...docxSource,
        versionDeletedAt: new Date(),
      },
      encryptedFile: {
        ...docxSource,
        content: { ...selectedFileContent, encrypted: true },
      },
      mismatchedCurrentVersion: {
        ...docxSource,
        currentVersionId: toSafeId<"entityVersion">("other_version"),
      },
      mismatchedFieldVersion: {
        ...docxSource,
        fieldEntityVersionId: toSafeId<"entityVersion">("other_version"),
      },
      readOnlyEntity: {
        ...docxSource,
        entityReadOnly: true,
      },
    } satisfies Record<
      string,
      Parameters<typeof isCurrentNativeExtractionSource>[1]
    >;

    for (const candidate of Object.values(rejectionCases)) {
      expect(isCurrentNativeExtractionSource(docxRun, candidate)).toBe(false);
    }
  });
});

describe("classifyOcrProjectionSource", () => {
  test("preserves an inactive workspace cancellation for recovery", () => {
    expect(
      classifyOcrProjectionSource({
        run,
        source,
        workspaceStatus: "archived",
      }),
    ).toBe("workspace_unavailable");
    expect(
      classifyOcrProjectionSource({
        run,
        source,
        workspaceStatus: "deleting",
      }),
    ).toBe("workspace_unavailable");
  });

  test("classifies only an active stale source as superseded", () => {
    expect(
      classifyOcrProjectionSource({
        run,
        source: {
          ...source,
          content: { ...fileContent, sha256Hex: "b".repeat(64) },
        },
        workspaceStatus: "active",
      }),
    ).toBe("source_superseded");
  });
});

describe("classifyOcrWorkspaceDispatch", () => {
  test("defers only manual requests while workspace deletion is reversible", () => {
    expect(
      classifyOcrWorkspaceDispatch({
        requestSource: "manual",
        workspaceStatus: "deleting",
      }),
    ).toBe("deferred");

    for (const requestSource of ["upload", "repair"] as const) {
      expect(
        classifyOcrWorkspaceDispatch({
          requestSource,
          workspaceStatus: "deleting",
        }),
      ).toBe("workspace_unavailable");
    }
    for (const workspaceStatus of ["archived", undefined] as const) {
      expect(
        classifyOcrWorkspaceDispatch({
          requestSource: "manual",
          workspaceStatus,
        }),
      ).toBe("workspace_unavailable");
    }
  });

  test("allows dispatch in an active workspace", () => {
    expect(
      classifyOcrWorkspaceDispatch({
        requestSource: "manual",
        workspaceStatus: "active",
      }),
    ).toBe("available");
  });
});

describe("requiresOcrPolicy", () => {
  test("applies opt-out to every automatic request source", () => {
    expect(requiresOcrPolicy("upload")).toBe(true);
    expect(requiresOcrPolicy("repair")).toBe(true);
    expect(requiresOcrPolicy("manual")).toBe(false);
  });
});

describe("ownsPromotedManualOcrClaim", () => {
  test("continues only for a running manual claim held by this worker", () => {
    const claimToken = "claim-a";

    expect(
      ownsPromotedManualOcrClaim({
        claimToken,
        run: {
          claimedBy: claimToken,
          requestSource: "manual",
          status: "running",
        },
      }),
    ).toBe(true);

    for (const candidate of [
      {
        claimedBy: "claim-b",
        requestSource: "manual",
        status: "running",
      },
      {
        claimedBy: claimToken,
        requestSource: "upload",
        status: "running",
      },
      {
        claimedBy: claimToken,
        requestSource: "manual",
        status: "queued",
      },
      undefined,
    ] as const) {
      expect(ownsPromotedManualOcrClaim({ claimToken, run: candidate })).toBe(
        false,
      );
    }
  });
});

describe("automatic projection ownership", () => {
  test("keeps all-null legacy text but rejects partial provenance", () => {
    expect(
      isPreservableAutomaticProjection({
        currentEntityVersionId: run.entityVersionId,
        currentWorkspaceId: workspaceId,
        provenance: {
          sourceEntityVersionId: null,
          sourceFieldId: null,
          sourceFileId: null,
          sourceSha256Hex: null,
        },
        sourceField: null,
      }),
    ).toBe(true);
    expect(
      isPreservableAutomaticProjection({
        currentEntityVersionId: run.entityVersionId,
        currentWorkspaceId: workspaceId,
        provenance: {
          sourceEntityVersionId: null,
          sourceFieldId: null,
          sourceFileId: fileContent.id,
          sourceSha256Hex: null,
        },
        sourceField: null,
      }),
    ).toBe(false);
  });

  test("preserves a valid current projection from another file field", () => {
    expect(selectedSourceField.id).not.toBe(run.fieldId);
    expect(
      isPreservableAutomaticProjection({
        currentEntityVersionId: run.entityVersionId,
        currentWorkspaceId: workspaceId,
        provenance: {
          sourceEntityVersionId: run.entityVersionId,
          sourceFieldId: selectedSourceField.id,
          sourceFileId: selectedFileContent.id,
          sourceSha256Hex: selectedFileContent.sha256Hex,
        },
        sourceField: selectedSourceField,
      }),
    ).toBe(true);
  });

  test("rejects a projection when its selected file has changed", () => {
    expect(
      isPreservableAutomaticProjection({
        currentEntityVersionId: run.entityVersionId,
        currentWorkspaceId: workspaceId,
        provenance: {
          sourceEntityVersionId: run.entityVersionId,
          sourceFieldId: selectedSourceField.id,
          sourceFileId: selectedFileContent.id,
          sourceSha256Hex: "c".repeat(64),
        },
        sourceField: selectedSourceField,
      }),
    ).toBe(false);
  });

  test("only automatic OCR preserves an existing current projection", () => {
    expect(shouldPreserveCurrentProjection("upload")).toBe(true);
    expect(shouldPreserveCurrentProjection("repair")).toBe(true);
    expect(shouldPreserveCurrentProjection("manual")).toBe(false);
  });
});

describe("bounded search-index replay", () => {
  test("classifies a stalled initial index write for durable replay", async () => {
    const indexed = await indexDocumentProjection({
      indexEntity: async () => await new Promise<void>(() => {}),
      timeoutMs: 5,
    });

    expect(Result.isError(indexed)).toBe(true);
    if (Result.isOk(indexed)) {
      return;
    }
    expect(indexed.error).toBeInstanceOf(DocumentProcessingJobError);
    expect(indexed.error.code).toBe("search_index_failed");
    expect(isRetryableSearchIndexFailure(indexed.error.code)).toBe(true);
    expect(indexed.error.cause).toBeInstanceOf(TimeoutError);
    expect(indexed.error.cause).toMatchObject({
      label: "document processing initial search index",
      timeoutMs: 5,
    });
  });

  test("surfaces index failures through the shared job boundary", async () => {
    const providerFailure = new Error("search provider unavailable");

    expect(
      indexDocumentProjectionAtJobBoundary({
        indexEntity: async () => await Promise.reject(providerFailure),
      }),
    ).rejects.toMatchObject({
      code: "search_index_failed",
      cause: providerFailure,
    });

    const processStart = queueSource.indexOf(
      "export const processDocumentProcessingRun",
    );
    const processEnd = queueSource.indexOf("\nconst errorCode", processStart);
    const processSource = queueSource.slice(processStart, processEnd);
    expect(
      processSource.match(/await indexDocumentProjectionAtJobBoundary/gu),
    ).toHaveLength(2);
    expect(processSource).not.toContain("await indexDocumentProjection({");
  });

  test("recovers from the current projection rather than the failed run source", () => {
    const replayStart = queueSource.indexOf(
      "const recoverFailedOcrSearchIndexes",
    );
    const replayCandidateBoundary = queueSource.indexOf(
      "if (candidates.length === 0)",
      replayStart,
    );
    const replaySelection = queueSource.slice(
      replayStart,
      replayCandidateBoundary,
    );

    expect(replayStart).toBeGreaterThan(-1);
    expect(replayCandidateBoundary).toBeGreaterThan(replayStart);
    expect(replaySelection).toContain("searchIndexProjectionSourceFields");
    expect(replaySelection).toContain("extractedContent.sourceFieldId");
    expect(replaySelection).toContain("entities.currentVersionId");
    expect(replaySelection).not.toContain("documentProcessingRuns.fieldId");
    expect(replaySelection).not.toContain(
      "documentProcessingRuns.sourceFileId",
    );
    expect(replaySelection).not.toContain(
      "documentProcessingRuns.sourceSha256Hex",
    );
    expect(replaySelection).toContain(".limit(SEARCH_INDEX_REPLAY_BATCH_SIZE)");
    expect(replaySelection).not.toContain(".limit(RECONCILE_BATCH_SIZE)");
    expect(queueSource).toContain(
      "const SEARCH_INDEX_REPLAY_BATCH_SIZE = SEARCH_INDEX_REPLAY_CONCURRENCY * 2",
    );
  });

  test("fails a black-holed attempt by its deadline and continues later phases", async () => {
    const calls: string[] = [];
    const phaseErrors: unknown[] = [];
    let replayError: unknown;
    const results = await runDocumentProcessingReconciliationPhases({
      phases: [
        {
          name: "reindex",
          run: async () => ({
            count: Number(
              await runSearchIndexReplayAttempt({
                indexEntity: async () => await new Promise<void>(() => {}),
                onFailure: async (error) => {
                  replayError = error;
                  calls.push("reindex-failed");
                },
                onSuccess: async () => {
                  calls.push("reindex-succeeded");
                  return true;
                },
                timeoutMs: 5,
              }),
            ),
            hasMore: false,
          }),
        },
        {
          name: "retry",
          run: async () => {
            calls.push("retry");
            return { count: 2, hasMore: false };
          },
        },
      ],
      onPhaseError: (error) => {
        phaseErrors.push(error);
      },
    });

    expect(replayError).toBeInstanceOf(TimeoutError);
    expect(replayError).toMatchObject({
      label: "document OCR search-index replay",
      timeoutMs: 5,
    });
    expect(calls).toEqual(["reindex-failed", "retry"]);
    expect(phaseErrors).toEqual([]);
    expect(results.reindex.count).toBe(0);
    expect(results.retry.count).toBe(2);
  });

  test("bounds stalled failure and success state transitions", async () => {
    await Promise.all(
      (["failure", "success"] as const).map(async (transition) => {
        const indexError = new Error("index unavailable");
        const rejection: unknown = await runSearchIndexReplayAttempt({
          indexEntity: async () => {
            if (transition === "failure") {
              throw indexError;
            }
          },
          onFailure: async () => {
            if (transition === "failure") {
              await new Promise<void>(() => {});
            }
          },
          onSuccess: async () => {
            await new Promise<void>(() => {});
            return true;
          },
          timeoutMs: 5,
          transitionTimeoutMs: 5,
        }).then(
          () => null,
          (error: unknown) => error,
        );

        expect(rejection).toBeInstanceOf(TimeoutError);
        expect(rejection).toMatchObject({
          label: `document OCR search-index replay ${transition} transition`,
          timeoutMs: 5,
        });
      }),
    );
  });
});

describe("stale OCR lease recovery", () => {
  test("terminates capped automatic OCR but leaves manual and index replay claims recoverable", () => {
    expect(
      shouldFailStaleAutomaticOcrRun({
        attemptCount: 5,
        errorCode: null,
        requestSource: "upload",
      }),
    ).toBe(true);
    expect(
      shouldFailStaleAutomaticOcrRun({
        attemptCount: 5,
        errorCode: null,
        requestSource: "manual",
      }),
    ).toBe(false);
    expect(
      shouldFailStaleAutomaticOcrRun({
        attemptCount: 5,
        errorCode: "search_index_failed",
        requestSource: "repair",
      }),
    ).toBe(false);
  });
});

describe("automatic OCR failure recovery", () => {
  test("uses bounded exponential backoff", () => {
    expect(automaticOcrRetryDelayMs(1)).toBe(30_000);
    expect(automaticOcrRetryDelayMs(2)).toBe(60_000);
    expect(automaticOcrRetryDelayMs(10)).toBe(30 * 60 * 1000);
  });

  test("requeues only retryable automatic failures below the attempt cap", () => {
    expect(
      isRetryableAutomaticOcrFailure({
        attemptCount: 1,
        errorCode: "not_configured",
        requestSource: "upload",
      }),
    ).toBe(true);
    expect(
      isRetryableAutomaticOcrFailure({
        attemptCount: 4,
        errorCode: "request_failed",
        requestSource: "upload",
      }),
    ).toBe(true);
    expect(
      isRetryableAutomaticOcrFailure({
        attemptCount: 5,
        errorCode: "request_failed",
        requestSource: "upload",
      }),
    ).toBe(false);
    expect(
      isRetryableAutomaticOcrFailure({
        attemptCount: 1,
        errorCode: "invalid_response",
        requestSource: "repair",
      }),
    ).toBe(false);
    expect(
      isRetryableAutomaticOcrFailure({
        attemptCount: 1,
        errorCode: "processing_failed",
        requestSource: "manual",
      }),
    ).toBe(false);
  });

  test("keeps committed projections recoverable independently of OCR attempts", () => {
    expect(isRetryableSearchIndexFailure("search_index_failed")).toBe(true);
    expect(isRetryableSearchIndexFailure("processing_failed")).toBe(false);
  });
});

describe("unconfigured worker lifecycle", () => {
  test("starts native processing while publishing OCR readiness only when configured", () => {
    const configurationCheck = queueSource.indexOf(
      "const ocrConfigured = isLocalDocumentOcrConfigured()",
    );
    const consumerStart = queueSource.indexOf(
      "const worker = new Worker<DocumentProcessingJobData>",
    );
    const readinessGuard = queueSource.indexOf(
      "if (ocrConfigured)",
      consumerStart,
    );

    expect(configurationCheck).toBeGreaterThan(-1);
    expect(consumerStart).toBeGreaterThan(configurationCheck);
    expect(readinessGuard).toBeGreaterThan(consumerStart);
  });
});

describe("worker interruption lifecycle", () => {
  test("aborts active work before waiting for the queue consumer to close", async () => {
    const calls: string[] = [];

    await abortDocumentProcessingWorkerBeforeClose({
      abortLifecycle: () => {
        calls.push("abort");
      },
      closeWorker: async () => {
        calls.push("close");
      },
    });

    expect(calls).toEqual(["abort", "close"]);
  });

  test("returns an interrupted claim to the queue without recording a failure", async () => {
    const lifecycle = new AbortController();
    lifecycle.abort();
    const calls: string[] = [];

    const outcome = await settleDocumentProcessingAttemptError({
      error: lifecycle.signal.reason,
      lifecycleSignal: lifecycle.signal,
      markFailed: async () => {
        calls.push("failed");
        return "settled";
      },
      returnToQueue: async () => {
        calls.push("queued");
      },
    });

    expect(outcome).toBe("interrupted");
    expect(calls).toEqual(["queued"]);
  });

  test("records ordinary processing errors through the existing failure path", async () => {
    const calls: string[] = [];

    const outcome = await settleDocumentProcessingAttemptError({
      error: new Error("processing failed"),
      lifecycleSignal: new AbortController().signal,
      markFailed: async () => {
        calls.push("failed");
        return "settled";
      },
      returnToQueue: async () => {
        calls.push("queued");
      },
    });

    expect(outcome).toBe("failed");
    expect(calls).toEqual(["failed"]);
  });

  test("does not refund an ordinary failure when shutdown races with settlement", async () => {
    const lifecycle = new AbortController();
    lifecycle.abort();
    const calls: string[] = [];

    const outcome = await settleDocumentProcessingAttemptError({
      error: new Error("indexing failed"),
      lifecycleSignal: lifecycle.signal,
      markFailed: async () => {
        calls.push("failed");
        return "settled";
      },
      returnToQueue: async () => {
        calls.push("queued");
      },
    });

    expect(outcome).toBe("failed");
    expect(calls).toEqual(["failed"]);
  });

  test("finds lifecycle cancellation through OCR error causes", async () => {
    const lifecycle = new AbortController();
    lifecycle.abort();
    const calls: string[] = [];

    const outcome = await settleDocumentProcessingAttemptError({
      error: { cause: { cause: lifecycle.signal.reason } },
      lifecycleSignal: lifecycle.signal,
      markFailed: async () => {
        calls.push("failed");
        return "settled";
      },
      returnToQueue: async () => {
        calls.push("queued");
      },
    });

    expect(outcome).toBe("interrupted");
    expect(calls).toEqual(["queued"]);
  });

  test("leaves a lost claim available to the job-level reporter", async () => {
    const outcome = await settleDocumentProcessingAttemptError({
      error: new Error("processing failed after claim loss"),
      lifecycleSignal: new AbortController().signal,
      markFailed: async () => "unsettled",
      returnToQueue: async () => undefined,
    });

    expect(outcome).toBe("unsettled");
  });

  test("threads shutdown cancellation into OCR and still fails BullMQ delivery", () => {
    expect(queueSource).toContain("signal: lifecycleSignal");
    expect(queueSource).toContain(
      "throw new DocumentProcessingRunSettledError",
    );
    expect(queueSource).toContain("cause: processingResult.error");
    expect(queueSource).toContain('if (settlement === "unsettled")');
    expect(queueSource).toContain("throw processingResult.error");
    expect(queueSource).toContain(
      'logger.warn("document_processing.attempt_failed", {\n      ...documentProcessingFailureFields(error)',
    );
  });

  test("leaves a settled attempt to the run-level path that already reported it", () => {
    expect(
      documentProcessingFailureReport(
        new DocumentProcessingRunSettledError({
          cause: new Error("parser exited nonzero"),
          message: "parser exited nonzero",
        }),
      ),
    ).toBe(DOCUMENT_PROCESSING_FAILURE_REPORT.ALREADY_REPORTED);
  });

  test("keeps a settled attempt settled even when it wraps a transient drop", () => {
    const dropped = new Error("Connection is closed");
    Object.assign(dropped, { code: "ERR_REDIS_CONNECTION_CLOSED" });

    expect(
      documentProcessingFailureReport(
        new DocumentProcessingRunSettledError({
          cause: dropped,
          message: dropped.message,
        }),
      ),
    ).toBe(DOCUMENT_PROCESSING_FAILURE_REPORT.ALREADY_REPORTED);
  });

  test("reports a transient drop reaching the job unsettled as a disruption", () => {
    const dropped = new Error("Connection is closed");
    Object.assign(dropped, { code: "ERR_REDIS_CONNECTION_CLOSED" });

    expect(documentProcessingFailureReport(dropped)).toBe(
      DOCUMENT_PROCESSING_FAILURE_REPORT.TRANSIENT_CONNECTION,
    );
  });

  test("reports a failure that never reached a claimed run as machinery", () => {
    expect(documentProcessingFailureReport(new Error("claim failed"))).toBe(
      DOCUMENT_PROCESSING_FAILURE_REPORT.MACHINERY,
    );
  });

  test("uses one compare-and-set transition to restore the claimed attempt", () => {
    const transitionStart = queueSource.indexOf(
      "const returnInterruptedRunToQueue",
    );
    const transitionEnd = queueSource.indexOf(
      "const earlierFileFields",
      transitionStart,
    );
    const transition = queueSource.slice(transitionStart, transitionEnd);

    expect(transitionStart).toBeGreaterThan(-1);
    expect(transitionEnd).toBeGreaterThan(transitionStart);
    expect(transition).toContain(
      "attemptCount: Math.max(0, run.attemptCount - 1)",
    );
    expect(transition).toContain('status: "queued"');
    expect(transition).toContain(
      'eq(documentProcessingRuns.status, "running")',
    );
    expect(transition).toContain(
      "eq(documentProcessingRuns.attemptCount, run.attemptCount)",
    );
    expect(transition).toContain(
      "eq(documentProcessingRuns.claimedBy, claimToken)",
    );
    expect(
      transition.match(/\.update\(documentProcessingRuns\)/gu),
    ).toHaveLength(1);
  });
});

/**
 * The class these pin: reconciliation drains each backlog one capped batch
 * per tick, and a phase's effect count is routinely smaller than the rows
 * it read (candidates filtered out, compare-and-set losses, replays that
 * fail). Inferring "more remains" from that count therefore reads a
 * saturated phase as drained and lets the batch worker exit mid-drain, so
 * each phase states its own saturation and this only collects the answers.
 */
/**
 * The class this pins: a closed broker connection used to end the loop's
 * usefulness for the rest of the process's life, because nothing behind the
 * phase ever reconnected. Recovery is the connection's own property now, so
 * the loop only has to survive the tick that saw the failure and run the next
 * one against the replacement.
 */
describe("reconciliation across a closed broker connection", () => {
  test("the tick after a closed-connection failure reports real counts", async () => {
    const connectionClosed = Object.assign(new Error("Connection closed"), {
      code: "ERR_REDIS_CONNECTION_CLOSED",
    });
    // The classifier is what decides this failure is worth another tick; a
    // drifted code would make the assertions below pass for the wrong reason.
    expect(isTransientRedisConnectionError(connectionClosed)).toBe(true);

    let ticks = 0;
    const errors: unknown[] = [];
    const runTick = async () =>
      await runDocumentProcessingReconciliationPhases({
        onPhaseError: (error) => {
          errors.push(error);
        },
        phases: [
          {
            name: "repair",
            run: async () => {
              ticks += 1;
              if (ticks === 1) {
                throw connectionClosed;
              }
              return await Promise.resolve({ count: 3, hasMore: false });
            },
          },
        ],
      });

    const first = await runTick();
    const second = await runTick();

    expect(errors).toEqual([connectionClosed]);
    // A failed phase proves nothing about its own backlog, so the tick that
    // hit the closed connection reports work left behind...
    expect(first.repair).toEqual({ count: 0, hasMore: true });
    // ...and the next one drains for real instead of repeating the failure.
    expect(second.repair).toEqual({ count: 3, hasMore: false });
  });
});

describe("reconciliationLeftWorkBehind", () => {
  const resultsOf = async (
    phases: Parameters<
      typeof runDocumentProcessingReconciliationPhases
    >[0]["phases"],
  ) =>
    await runDocumentProcessingReconciliationPhases({
      onPhaseError: () => undefined,
      phases,
    });

  test("a large effect count with no phase saturated leaves nothing behind", async () => {
    expect(
      reconciliationLeftWorkBehind(
        await resultsOf([
          {
            name: "repair",
            run: async () => ({ count: 10_000, hasMore: false }),
          },
        ]),
      ),
    ).toBe(false);
  });

  test("every declared phase runs and states its own signal", async () => {
    const drained = await resultsOf([]);
    const declared = Object.keys(drained).toSorted();
    // Both directions against the list the worker actually passes: a phase
    // declared but never wired in reports nothing and would be read as
    // drained; a phase run but not declared has nowhere to report.
    expect(declared).toEqual([
      "deadline-scout",
      "delivery",
      "reindex",
      "repair",
      "retry",
      "stale-lease",
    ]);
    const executed = DOCUMENT_PROCESSING_RECONCILIATION_PHASES.map(
      ({ name }): string => name,
    ).toSorted();
    expect(executed).toEqual(declared);
    for (const phase of Object.keys(drained)) {
      expect(
        reconciliationLeftWorkBehind({
          ...drained,
          [phase]: { count: 0, hasMore: true },
        }),
      ).toBe(true);
    }
  });

  test("a phase that acted on almost nothing still reports its backlog", async () => {
    expect(
      reconciliationLeftWorkBehind(
        await resultsOf([
          { name: "repair", run: async () => ({ count: 1, hasMore: true }) },
        ]),
      ),
    ).toBe(true);
  });

  test("every phase runs ahead of the phases it feeds", () => {
    const order = DOCUMENT_PROCESSING_RECONCILIATION_PHASES.map(
      ({ name }): string => name,
    );
    const feeds = Object.entries(
      DOCUMENT_PROCESSING_RECONCILIATION_PHASE_FEEDS,
    );

    // Both directions again, this time between the declared edges and the
    // order they constrain: an edge whose consumer is missing from the
    // order, or a phase that produces work for a phase that already ran,
    // fails here. That second case is what leaves a tick's own output
    // waiting for the next tick.
    expect(feeds.map(([phase]) => phase).toSorted()).toEqual(order.toSorted());
    for (const [phase, consumers] of feeds) {
      for (const consumer of consumers) {
        expect(order.indexOf(consumer)).toBeGreaterThan(order.indexOf(phase));
      }
    }
  });

  test("a failed phase counts as work left behind", async () => {
    // It drained nothing it can prove, and a zero count would otherwise
    // read as drained.
    const results = await resultsOf([
      {
        name: "repair",
        run: async () => {
          throw new Error("repair unavailable");
        },
      },
    ]);

    expect(results.repair).toEqual({ count: 0, hasMore: true });
    expect(reconciliationLeftWorkBehind(results)).toBe(true);
  });
});

/**
 * The repair sweep is where count, cursor, and backlog all diverge: it
 * scans a page of candidate fields, filters nearly all of them, and
 * creates runs only for the survivors. The created-run count says nothing
 * about whether the scan reached the end of the table, and the end of the
 * scan says nothing about the runs it just created, which the delivery
 * phase still has to hand off.
 */
describe("resolveRepairScanPage", () => {
  const fieldIds = (count: number) =>
    Array.from({ length: count }, () => toSafeId<"field">(Bun.randomUUIDv7()));

  test("a full page whose candidates were filtered out still has another page", () => {
    const scannedFieldIds = fieldIds(RECONCILE_BATCH_SIZE);

    expect(
      resolveRepairScanPage({ createdRunCount: 0, scannedFieldIds }),
    ).toEqual({
      count: 0,
      hasMore: true,
      nextCursor: scannedFieldIds.at(-1) ?? null,
    });
  });

  test("a short page ends the scan whether or not it created runs", () => {
    const scannedFieldIds = fieldIds(RECONCILE_BATCH_SIZE - 1);

    // The runs it created are due input for reindex and delivery, both of
    // which run later in this tick and answer for them: this phase reports
    // only its own backlog, which the short page ended.
    for (const createdRunCount of [0, 2]) {
      expect(
        resolveRepairScanPage({ createdRunCount, scannedFieldIds }),
      ).toEqual({
        count: createdRunCount,
        hasMore: false,
        nextCursor: null,
      });
    }
  });
});

/**
 * Work a phase leaves for itself is the one kind the phase order cannot
 * place, so each of those phases has to report it.
 */
describe("work a phase keeps for itself", () => {
  test("a replay claimed but not completed keeps the reindex phase unfinished", () => {
    // It went back to failed with a backoff, which is this phase's own
    // input: no later phase selects it.
    expect(
      resolveSearchIndexReplayBatch({
        claimedCount: 4,
        recoveredCount: 1,
        saturated: false,
      }),
    ).toEqual({ count: 1, hasMore: true });

    expect(
      resolveSearchIndexReplayBatch({
        claimedCount: 4,
        recoveredCount: 4,
        saturated: false,
      }),
    ).toEqual({ count: 4, hasMore: false });
  });

  test("a failed handoff keeps the delivery phase unfinished", () => {
    // The run stays queued and rescheduled, and delivery is the only phase
    // that takes queued rows, so nothing later in this tick can.
    expect(
      resolveScheduledDeliveryBatch({
        attempted: 3,
        retryAt: new Date("2030-01-01T00:00:30.000Z"),
        saturated: false,
      }),
    ).toEqual({ count: 3, hasMore: true });

    expect(
      resolveScheduledDeliveryBatch({
        attempted: 3,
        retryAt: null,
        saturated: false,
      }),
    ).toEqual({ count: 3, hasMore: false });

    // The other half of the rule: a selection that hit its cap reports
    // more even when every handoff in it succeeded.
    expect(
      resolveScheduledDeliveryBatch({
        attempted: RECONCILE_BATCH_SIZE,
        retryAt: null,
        saturated: true,
      }),
    ).toEqual({ count: RECONCILE_BATCH_SIZE, hasMore: true });
  });
});

/**
 * The class these pin: the sampler's verdict must not depend on how its
 * cadence lines up with the reconciliation cadence. Reading a snapshot
 * mid-tick gets that wrong in both directions: a sampler that keeps
 * landing inside slow ticks would see "running" at every sample and never
 * exit, and one that lands just before a tick reports would exit on the
 * previous tick's answer. A sample therefore waits for the tick in flight.
 */
describe("createReconciliationProgress", () => {
  /** A tick the test settles on demand, standing in for a slow drain. */
  const pendingTick = () => {
    let settle: (leftWorkBehind: boolean) => void = () => undefined;
    return {
      run: async () =>
        await new Promise<boolean>((resolve) => {
          settle = resolve;
        }),
      settle: (leftWorkBehind: boolean) => {
        settle(leftWorkBehind);
      },
    };
  };

  const sampler = (
    progress: ReturnType<typeof createReconciliationProgress>,
    countPending: () => Promise<number> = async () => 0,
  ) => {
    let exits = 0;
    const sample = createIdleExitCheck({
      countPending,
      hasUnfinishedReconciliation: progress.hasUnfinishedWork,
      isReconciliationInFlight: progress.isTickRunning,
      reconciliationGeneration: progress.tickGeneration,
      onCheckFailure: () => undefined,
      onIdleExit: () => {
        exits += 1;
      },
      requiredIdleChecks: 1,
    });
    return { exits: () => exits, sample };
  };

  test("a sample inside a tick waits for that tick, not the last one", async () => {
    const progress = createReconciliationProgress();
    // The last completed tick was drained: a snapshot read would exit on it.
    await progress.runTick(async () => false);
    const tick = pendingTick();
    const inFlight = progress.runTick(tick.run);
    const h = sampler(progress);

    const outcome = h.sample();
    await Bun.sleep(5);
    expect(h.exits()).toBe(0);

    tick.settle(true);
    await inFlight;

    expect(await outcome).toBe("checked");
    expect(h.exits()).toBe(0);
  });

  test("a slow tick that drains still lets the worker exit, whenever the sample lands", async () => {
    const progress = createReconciliationProgress();
    const tick = pendingTick();
    const inFlight = progress.runTick(tick.run);
    const h = sampler(progress);

    // Every sample lands inside the tick, the alignment that would strand
    // a snapshot-reading sampler forever.
    const outcome = h.sample();
    await Bun.sleep(5);
    tick.settle(false);
    await inFlight;

    expect(await outcome).toBe("exit");
    expect(h.exits()).toBe(1);
  });

  test("jobs the tick enqueues before draining are in the count it is sampled against", async () => {
    const progress = createReconciliationProgress();
    let queueDepth = 0;
    const tick = pendingTick();
    const inFlight = progress.runTick(tick.run);
    const h = sampler(progress, async () => queueDepth);

    const outcome = h.sample();
    await Bun.sleep(5);
    // What the delivery phase does: hand recovered runs to the queue, then
    // report the tick drained. Counting before waiting for that verdict
    // would pair this tick's empty "before" with its drained "after".
    queueDepth = 3;
    tick.settle(false);
    await inFlight;

    expect(await outcome).toBe("checked");
    expect(h.exits()).toBe(0);
  });

  test("a tick that starts as the count resolves is waited out by that sample", async () => {
    const progress = createReconciliationProgress();
    const tick = pendingTick();
    const ticks: Promise<void>[] = [];
    const h = sampler(
      progress,
      async () =>
        await Promise.resolve(0).then((pending) => {
          // The reconcile timer fires between the count resolving and the
          // sampler resuming. The tick's own prologue marks it running
          // before its first await, so the sample measures again and that
          // second pass waits for this tick's verdict.
          if (ticks.length === 0) {
            ticks.push(progress.runTick(tick.run));
          }
          return pending;
        }),
    );

    const outcome = h.sample();
    await Bun.sleep(5);
    // Still measuring: nothing has been decided on the stale verdict.
    expect(h.exits()).toBe(0);

    tick.settle(true);
    await Promise.all(ticks);

    expect(await outcome).toBe("checked");
    expect(h.exits()).toBe(0);
  });

  /**
   * A tick can also open and close entirely inside the count: nothing is
   * running when the sample resumes, and the verdict it took belongs to
   * the tick before, so only the generation records that it ran at all.
   */
  const samplerRunningATickInsideTheCount = (
    progress: ReturnType<typeof createReconciliationProgress>,
    leftWorkBehind: boolean,
  ) => {
    let ran = false;
    return sampler(
      progress,
      async () =>
        await Promise.resolve(0).then(async (pending) => {
          if (!ran) {
            ran = true;
            await progress.runTick(async () => leftWorkBehind);
          }
          return pending;
        }),
    );
  };

  test("a saturated tick that fits inside the count is not exited past", async () => {
    const progress = createReconciliationProgress();
    // The verdict this sample waits on is the drained tick before it.
    await progress.runTick(async () => false);
    const h = samplerRunningATickInsideTheCount(progress, true);

    expect(await h.sample()).toBe("checked");
    expect(h.exits()).toBe(0);
    // And the sample after it reads that tick's own verdict.
    expect(await h.sample()).toBe("checked");
    expect(h.exits()).toBe(0);
  });

  test("a drained tick that fits inside the count is resolved by the same sample", async () => {
    const progress = createReconciliationProgress();
    await progress.runTick(async () => false);
    const h = samplerRunningATickInsideTheCount(progress, false);

    // The crossing moved the generation, so the sample measures again: it
    // re-reads the verdict, which is now that tick's own and drained, and
    // re-counts what it enqueued. Nothing is left, so the sample completes
    // rather than being spent on the crossing.
    expect(await h.sample()).toBe("exit");
    expect(h.exits()).toBe(1);
  });

  test("a saturated tick keeps the worker alive", async () => {
    const progress = createReconciliationProgress();
    await progress.runTick(async () => true);
    const h = sampler(progress);

    expect(await h.sample()).toBe("checked");
    expect(h.exits()).toBe(0);

    await progress.runTick(async () => false);

    expect(await h.sample()).toBe("exit");
  });

  test("a tick that never reported leaves work unfinished", async () => {
    const progress = createReconciliationProgress();
    await progress.runTick(async () => false);

    const rejection: unknown = await progress
      .runTick(async () => {
        throw new Error("reconcile unavailable");
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(rejection).toBeInstanceOf(Error);
    expect(await progress.hasUnfinishedWork()).toBe(true);
  });
});
