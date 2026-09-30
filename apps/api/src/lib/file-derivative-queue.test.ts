import { DelayedError } from "bullmq";
import { describe, expect, test } from "bun:test";

import { deferFileDerivativeForPendingReservation } from "@/api/lib/file-derivative-queue";
import {
  FILE_RESERVATION_ABANDON_DELAY_MS,
  OrganizationFileUsageError,
} from "@/api/lib/files/organization-file-usage";

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
