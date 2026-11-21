import { DelayedError } from "bullmq";
import { describe, expect, test } from "bun:test";

import { DERIVATIVE_FAILURE_REASON } from "@/api/db/schema-validators";
import {
  createFileDerivativeProcessor,
  deferFileDerivativeForPendingReservation,
  displayableConversionRefusal,
  FILE_DERIVATIVE_WORKER_CONCURRENCY,
  loadDerivativeSource,
} from "@/api/lib/file-derivative-queue";
import {
  FILE_RESERVATION_ABANDON_DELAY_MS,
  OrganizationFileUsageError,
} from "@/api/lib/files/organization-file-usage";
import { LIMITS } from "@/api/lib/limits";
import { createPressurePause } from "@/api/lib/memory-pressure";
import type { MemoryPressureCause } from "@/api/lib/memory-pressure";
import { S3ObjectBudgetError } from "@/api/lib/s3";

describe("displayable conversion refusals", () => {
  test("clips document-derived values to their persisted limits", () => {
    const oversized = "x".repeat(600);

    expect(
      displayableConversionRefusal({
        kind: "unsupported_reference",
        format: oversized,
        element: oversized,
        attribute: oversized,
      }),
    ).toEqual({
      kind: "unsupported_reference",
      format: "x".repeat(256),
      element: "x".repeat(512),
      attribute: "x".repeat(512),
    });
    expect(
      displayableConversionRefusal({
        kind: "unsupported_encoding",
        encoding: oversized,
      }),
    ).toEqual({ kind: "unsupported_encoding", encoding: "x".repeat(256) });
    expect(
      displayableConversionRefusal({
        kind: "unsupported_field",
        fieldType: oversized,
      }),
    ).toEqual({ kind: "unsupported_field", fieldType: "x".repeat(256) });
  });
});

describe("file derivative reservation recovery", () => {
  test("delays a busy same-key write past its recovery grace without failing the job", async () => {
    const now = Date.parse("2030-01-01T00:00:00.000Z");
    const delayed: { timestamp: number; token?: string }[] = [];
    const job = {
      token: "worker-claim",
      moveToDelayed: async (timestamp: number, token?: string) => {
        delayed.push(
          token === undefined ? { timestamp } : { timestamp, token },
        );
      },
    };

    const rejection = await deferFileDerivativeForPendingReservation({
      error: new OrganizationFileUsageError({
        message: "File write is already in progress",
        reason: "reservation_busy",
      }),
      job,
      now,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(DelayedError);

    expect(delayed).toHaveLength(1);
    expect(delayed.at(0)?.token).toBe(job.token);
    expect((delayed.at(0)?.timestamp ?? 0) - now).toBeGreaterThan(
      FILE_RESERVATION_ABANDON_DELAY_MS,
    );
  });

  test("ordinary write failures keep the bounded BullMQ failure path", async () => {
    const usageError = new OrganizationFileUsageError({
      message: "Organization file capacity exceeded",
      reason: "capacity_exceeded",
    });
    const delayed: number[] = [];
    const rejection = await deferFileDerivativeForPendingReservation({
      error: usageError,
      job: {
        moveToDelayed: async (timestamp) => {
          delayed.push(timestamp);
        },
      },
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBe(usageError);
    expect(delayed).toEqual([]);
  });
});

describe("file derivative source admission", () => {
  test("refuses a source over the byte budget without reading it", async () => {
    const reads: number[] = [];
    const loaded = await loadDerivativeSource({
      sizeBytes: LIMITS.fileDerivativeSourceMaxBytes + 1,
      read: async (maxBytes) => {
        reads.push(maxBytes);
        return new Uint8Array(0);
      },
    });

    expect(loaded).toEqual({
      type: "refused",
      reason: DERIVATIVE_FAILURE_REASON.TOO_LARGE,
    });
    expect(reads).toEqual([]);
  });

  test("bounds the read by the budget and refuses a store length past it", async () => {
    const reads: number[] = [];
    const loaded = await loadDerivativeSource({
      // The recorded size understates what the store holds.
      sizeBytes: 1024,
      read: async (maxBytes) => {
        reads.push(maxBytes);
        throw new S3ObjectBudgetError({
          message: "over budget",
          key: "org/ws/file",
          declaredBytes: maxBytes + 1,
          maxBytes,
        });
      },
    });

    expect(reads).toEqual([LIMITS.fileDerivativeSourceMaxBytes]);
    expect(loaded).toEqual({
      type: "refused",
      reason: DERIVATIVE_FAILURE_REASON.TOO_LARGE,
    });
  });

  test("admits a source within budget and reads it once", async () => {
    const source = new Uint8Array([1, 2, 3]);
    let reads = 0;
    const loaded = await loadDerivativeSource({
      sizeBytes: LIMITS.fileDerivativeSourceMaxBytes,
      read: async () => {
        reads += 1;
        return source;
      },
    });

    expect(loaded).toEqual({ type: "admitted", source });
    expect(reads).toBe(1);
  });
});

describe("file derivative worker", () => {
  test("runs one derivative at a time per process", () => {
    expect(FILE_DERIVATIVE_WORKER_CONCURRENCY).toBe(1);
  });

  const jobData = {
    entityId: "entity",
    fieldId: "field",
    organizationId: "organization",
    userId: null,
    workspaceId: "workspace",
  };

  /**
   * A worker reduced to its consumption contract: it takes waiting jobs one
   * at a time until paused, and resumes when told to. The gate, the pause
   * controller and the processor are the production ones.
   */
  const harness = (initialCause: MemoryPressureCause, waiting: number) => {
    let cause = initialCause;
    let paused = false;
    let pendingRecheck: (() => void) | null = null;
    const transitions: string[] = [];
    const ran: string[] = [];
    const delayed: { timestamp: number; token?: string }[] = [];
    const queue = Array.from({ length: waiting }, (_, index) =>
      index % 2 === 0 ? "generate-pdf" : "generate-thumbnail",
    );
    const now = Date.parse("2030-01-01T00:00:00.000Z");
    const gate = { read: () => ({ cause, rssBytes: 1 }) };
    const pausing = createPressurePause({
      gate,
      pause: () => {
        paused = true;
      },
      resume: () => {
        paused = false;
      },
      recheckMs: LIMITS.fileDerivativeDeferDelayMs,
      onClose: () => {
        transitions.push("closed");
      },
      onOpen: () => {
        transitions.push("opened");
      },
      setTimer: (run) => {
        pendingRecheck = run;
        return () => {
          pendingRecheck = null;
        };
      },
    });
    const handle = createFileDerivativeProcessor({
      memory: gate,
      now: () => now,
      pausing,
      processPdf: async () => {
        ran.push("pdf");
      },
      processThumbnail: async () => {
        ran.push("thumbnail");
      },
    });
    const claimed: string[] = [];
    // `paused` is flipped by the pause controller from inside `handle`.
    const isPaused = () => paused;
    const drain = async () => {
      while (!isPaused()) {
        const name = queue.shift();
        if (name === undefined) {
          return;
        }
        claimed.push(name);
        // A deferred job leaves the queue for its delay; BullMQ re-offers it later.
        await handle({
          data: jobData,
          name,
          token: "worker-claim",
          moveToDelayed: async (timestamp: number, token?: string) => {
            delayed.push(
              token === undefined ? { timestamp } : { timestamp, token },
            );
          },
        }).catch((error: unknown) => {
          if (!(error instanceof DelayedError)) {
            throw error;
          }
        });
      }
    };
    return {
      claimed,
      delayed,
      drain,
      isPaused,
      now,
      ran,
      recheck: () => {
        const run = pendingRecheck;
        pendingRecheck = null;
        run?.();
      },
      setCause: (next: MemoryPressureCause) => {
        cause = next;
      },
      transitions,
    };
  };

  test.each(["signal", "rss"] as const)(
    "under memory pressure (%s) one job is deferred, keeping its attempts, and the worker pauses",
    async (cause) => {
      const run = harness(cause, 20);

      await run.drain();

      expect(run.claimed).toHaveLength(1);
      expect(run.ran).toEqual([]);
      expect(run.delayed).toEqual([
        {
          timestamp: run.now + LIMITS.fileDerivativeDeferDelayMs,
          token: "worker-claim",
        },
      ]);
      expect(run.isPaused()).toBe(true);
      expect(run.transitions).toEqual(["closed"]);
    },
  );

  test("stays paused while the gate stays closed, then resumes once it opens", async () => {
    const run = harness("rss", 5);
    await run.drain();

    run.recheck();
    run.recheck();
    expect(run.isPaused()).toBe(true);
    expect(run.claimed).toHaveLength(1);

    run.setCause(null);
    run.recheck();
    expect(run.isPaused()).toBe(false);
    await run.drain();

    expect(run.ran).toEqual(["thumbnail", "pdf", "thumbnail", "pdf"]);
    // One log per transition, however many jobs and rechecks there were.
    expect(run.transitions).toEqual(["closed", "opened"]);
  });

  test("without pressure every job runs its derivative", async () => {
    const run = harness(null, 2);

    await run.drain();

    expect(run.ran).toEqual(["pdf", "thumbnail"]);
    expect(run.delayed).toEqual([]);
    expect(run.isPaused()).toBe(false);
    expect(run.transitions).toEqual([]);
  });
});
