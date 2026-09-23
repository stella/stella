import { describe, expect, mock, test } from "bun:test";

import { TimeoutError } from "@/api/lib/errors/tagged-errors";

import { requeueDeterministicJob } from "./bullmq-requeue";
import type { RequeueableQueue } from "./bullmq-requeue";

type Data = { id: string };

const neverSettles = new Promise<never>(() => {});
const pending = mock(async () => await neverSettles);
const settled = mock(async () => undefined);

const stalledQueues: readonly [string, RequeueableQueue<Data>][] = [
  ["get-job", { add: settled, getJob: pending }],
  [
    "get-state",
    {
      add: settled,
      getJob: async () => ({
        getState: pending,
        remove: settled,
        retry: settled,
      }),
    },
  ],
  [
    "retry-job",
    {
      add: settled,
      getJob: async () => ({
        getState: async () => "failed" as const,
        remove: settled,
        retry: pending,
      }),
    },
  ],
  [
    "remove-job",
    {
      add: settled,
      getJob: async () => ({
        getState: async () => "completed" as const,
        remove: pending,
        retry: settled,
      }),
    },
  ],
  ["add-job", { add: pending, getJob: async () => undefined }],
];

describe("requeueDeterministicJob", () => {
  test.each(stalledQueues)("bounds the %s command", async (command, queue) => {
    const rejection = await requeueDeterministicJob({
      data: { id: "row" },
      jobId: "row",
      name: "probe",
      operationTimeoutMs: 5,
      queue,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(TimeoutError);
    expect(rejection).toMatchObject({
      label: `queue-requeue.${command}`,
      timeoutMs: 5,
    });
  });

  test("retries a failed job in place when no delay is asked for", async () => {
    const add = mock(async () => undefined);
    const remove = mock(async () => undefined);
    const retry = mock(async () => undefined);

    await requeueDeterministicJob({
      data: { id: "row" },
      jobId: "row",
      name: "probe",
      queue: {
        add,
        getJob: async () => ({
          getState: async () => "failed" as const,
          remove,
          retry,
        }),
      },
    });

    expect(retry).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  test("replaces a failed job with a delayed one when a delay is asked for", async () => {
    const add = mock(async () => undefined);
    const remove = mock(async () => undefined);
    const retry = mock(async () => undefined);

    await requeueDeterministicJob({
      data: { id: "row" },
      delayMs: 900_000,
      jobId: "row",
      name: "probe",
      queue: {
        add,
        getJob: async () => ({
          getState: async () => "failed" as const,
          remove,
          retry,
        }),
      },
    });

    expect(retry).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(
      "probe",
      { id: "row" },
      { delay: 900_000, jobId: "row" },
    );
  });
});
