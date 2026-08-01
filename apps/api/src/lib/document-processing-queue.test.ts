import { describe, expect, test } from "bun:test";

import type { FieldContent } from "@/api/db/schema-validators";
import { toSafeId } from "@/api/lib/branded-types";
import {
  abortDocumentProcessingWorkerBeforeClose,
  automaticOcrRetryDelayMs,
  classifyOcrProjectionSource,
  classifyOcrWorkspaceDispatch,
  createDocumentProcessingLeaseRenewal,
  DocumentProcessingJobError,
  indexOcrProjection,
  isAutomaticOcrRepairCandidate,
  isCurrentOcrSource,
  isPreservableAutomaticProjection,
  isReversibleAutomaticOcrCancellation,
  isRetryableAutomaticOcrFailure,
  isRetryableSearchIndexFailure,
  mapWithConcurrency,
  ownsPromotedManualOcrClaim,
  readRepairScanCursor,
  revivableAutomaticOcrCancellationCodes,
  runDocumentProcessingReconciliationPhases,
  runSearchIndexReplayAttempt,
  settleDocumentProcessingAttemptError,
  requiresOcrPolicy,
  shouldFailStaleAutomaticOcrRun,
  shouldPreserveCurrentProjection,
  tryEnqueueDocumentProcessingRun,
  writeRepairScanCursor,
} from "@/api/lib/document-processing-queue";
import { TimeoutError } from "@/api/lib/errors/tagged-errors";

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
  test("continues later phases after an early phase fails", async () => {
    const calls: string[] = [];
    const failures: { error: unknown; phase: string }[] = [];
    const repairError = new Error("repair unavailable");

    const counts = await runDocumentProcessingReconciliationPhases({
      phases: [
        {
          name: "delivery",
          run: async () => {
            calls.push("delivery");
            return 5;
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
            return 2;
          },
        },
        {
          name: "retry",
          run: async () => {
            calls.push("retry");
            return 3;
          },
        },
        {
          name: "stale-lease",
          run: async () => {
            calls.push("stale-lease");
            return 4;
          },
        },
      ],
      onPhaseError: (error, phase) => {
        failures.push({ error, phase });
      },
    });

    expect(calls).toEqual([
      "delivery",
      "repair",
      "reindex",
      "retry",
      "stale-lease",
    ]);
    expect(failures).toEqual([{ error: repairError, phase: "repair" }]);
    expect(counts).toEqual({
      delivery: 5,
      reindex: 2,
      repair: 0,
      retry: 3,
      "stale-lease": 4,
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

describe("isAutomaticOcrRepairCandidate", () => {
  test("only repairs an unencrypted PDF source", () => {
    expect(isAutomaticOcrRepairCandidate(fileContent)).toBe(true);
    expect(
      isAutomaticOcrRepairCandidate({
        ...fileContent,
        encrypted: true,
      }),
    ).toBe(false);
    expect(
      isAutomaticOcrRepairCandidate({
        ...fileContent,
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ).toBe(false);
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

describe("isReversibleAutomaticOcrCancellation", () => {
  test("revives policy and workspace cancellations, but not source cancellation", () => {
    expect(
      isReversibleAutomaticOcrCancellation({
        errorCode: "policy_disabled",
        status: "cancelled",
      }),
    ).toBe(true);
    expect(
      isReversibleAutomaticOcrCancellation({
        errorCode: "workspace_unavailable",
        status: "cancelled",
      }),
    ).toBe(true);
    expect(
      isReversibleAutomaticOcrCancellation({
        errorCode: "source_superseded",
        status: "cancelled",
      }),
    ).toBe(false);
  });
});

describe("revivableAutomaticOcrCancellationCodes", () => {
  test("revives a superseded run only after the source is locked and rechecked", () => {
    expect(
      revivableAutomaticOcrCancellationCodes({
        hasLockedExactSource: false,
      }),
    ).not.toContain("source_superseded");
    expect(
      revivableAutomaticOcrCancellationCodes({
        hasLockedExactSource: true,
      }),
    ).toContain("source_superseded");
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
    const rejection: unknown = await indexOcrProjection({
      indexEntity: async () => await new Promise<void>(() => {}),
      timeoutMs: 5,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(DocumentProcessingJobError);
    if (!(rejection instanceof DocumentProcessingJobError)) {
      return;
    }
    expect(rejection.code).toBe("search_index_failed");
    expect(isRetryableSearchIndexFailure(rejection.code)).toBe(true);
    expect(rejection.cause).toBeInstanceOf(TimeoutError);
    expect(rejection.cause).toMatchObject({
      label: "document OCR initial search index",
      timeoutMs: 5,
    });
    expect(queueSource).toContain("await indexOcrProjection({");
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
    const counts = await runDocumentProcessingReconciliationPhases({
      phases: [
        {
          name: "reindex",
          run: async () =>
            Number(
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
        },
        {
          name: "retry",
          run: async () => {
            calls.push("retry");
            return 2;
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
    expect(counts.reindex).toBe(0);
    expect(counts.retry).toBe(2);
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

  test("does not execute more than its concurrency limit", async () => {
    let active = 0;
    let peakActive = 0;
    const values = await mapWithConcurrency({
      items: [1, 2, 3, 4, 5],
      limit: 2,
      operation: async (value) => {
        active += 1;
        peakActive = Math.max(peakActive, active);
        await Promise.resolve();
        active -= 1;
        return value;
      },
    });
    expect(values).toEqual([1, 2, 3, 4, 5]);
    expect(peakActive).toBe(2);
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
  test("keeps the entrypoint dormant without constructing a queue consumer", () => {
    const unconfiguredBranchStart = queueSource.indexOf(
      "if (!isDocumentOcrProviderConfigured())",
    );
    const consumerStart = queueSource.indexOf(
      "const worker = new Worker<DocumentProcessingJobData>",
      unconfiguredBranchStart,
    );
    const unconfiguredBranch = queueSource.slice(
      unconfiguredBranchStart,
      consumerStart,
    );

    expect(unconfiguredBranchStart).toBeGreaterThan(-1);
    expect(consumerStart).toBeGreaterThan(unconfiguredBranchStart);
    expect(unconfiguredBranch).toContain("setInterval(");
    expect(unconfiguredBranch).toContain("clearInterval(keepAliveInterval)");
    expect(unconfiguredBranch).not.toContain("new Worker");
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
      },
      returnToQueue: async () => {
        calls.push("queued");
      },
    });

    expect(outcome).toBe("failed");
    expect(calls).toEqual(["failed"]);
  });

  test("finds lifecycle cancellation through provider error causes", async () => {
    const lifecycle = new AbortController();
    lifecycle.abort();
    const calls: string[] = [];

    const outcome = await settleDocumentProcessingAttemptError({
      error: { cause: { cause: lifecycle.signal.reason } },
      lifecycleSignal: lifecycle.signal,
      markFailed: async () => {
        calls.push("failed");
      },
      returnToQueue: async () => {
        calls.push("queued");
      },
    });

    expect(outcome).toBe("interrupted");
    expect(calls).toEqual(["queued"]);
  });

  test("threads shutdown cancellation into OCR and still fails BullMQ delivery", () => {
    expect(queueSource).toContain("signal: lifecycleSignal");
    expect(queueSource).toContain("throw processingResult.error");
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
