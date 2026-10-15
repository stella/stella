import { DelayedError } from "bullmq";
import { describe, expect, test } from "bun:test";

import { DERIVATIVE_FAILURE_REASON } from "@/api/db/schema-validators";
import {
  createFileDerivativeProcessor,
  deferFileDerivativeForPendingReservation,
  FILE_DERIVATIVE_WORKER_CONCURRENCY,
  loadDerivativeSource,
} from "@/api/lib/file-derivative-queue";
import {
  FILE_RESERVATION_ABANDON_DELAY_MS,
  OrganizationFileUsageError,
} from "@/api/lib/files/organization-file-usage";
import { LIMITS } from "@/api/lib/limits";
import type { MemoryPressureCause } from "@/api/lib/memory-pressure";
import { S3ObjectBudgetError } from "@/api/lib/s3";

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

  const harness = (cause: MemoryPressureCause) => {
    const ran: string[] = [];
    const delayed: { timestamp: number; token?: string }[] = [];
    const now = Date.parse("2030-01-01T00:00:00.000Z");
    const handle = createFileDerivativeProcessor({
      memory: { read: () => ({ cause, rssBytes: 1 }) },
      now: () => now,
      processPdf: async () => {
        ran.push("pdf");
      },
      processThumbnail: async () => {
        ran.push("thumbnail");
      },
    });
    const job = (name: string) => ({
      data: jobData,
      name,
      token: "worker-claim",
      moveToDelayed: async (timestamp: number, token?: string) => {
        delayed.push(
          token === undefined ? { timestamp } : { timestamp, token },
        );
      },
    });
    return { delayed, handle, job, now, ran };
  };

  test.each(["signal", "rss"] as const)(
    "under memory pressure (%s) a job is deferred before any work, keeping its attempts",
    async (cause) => {
      const { delayed, handle, job, now, ran } = harness(cause);

      const rejection = await handle(job("generate-pdf")).then(
        () => null,
        (error: unknown) => error,
      );

      // DelayedError is how BullMQ moves a job back without failing it.
      expect(rejection).toBeInstanceOf(DelayedError);
      expect(ran).toEqual([]);
      expect(delayed).toEqual([
        {
          timestamp: now + LIMITS.fileDerivativeDeferDelayMs,
          token: "worker-claim",
        },
      ]);
    },
  );

  test("without pressure a job runs its derivative", async () => {
    const { delayed, handle, job, ran } = harness(null);

    await handle(job("generate-pdf"));
    await handle(job("generate-thumbnail"));

    expect(ran).toEqual(["pdf", "thumbnail"]);
    expect(delayed).toEqual([]);
  });
});
