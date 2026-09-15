import { describe, expect, test } from "bun:test";

import type { ChatAnonResult } from "@stll/anonymize-chat";

import { ClientOperationError } from "@/lib/errors/client";

import { createAnonymizeChatWorkerClient } from "./anonymize-chat-worker-client.logic";
import type {
  AnonymizeChatWorkerRequest,
  AnonymizeChatWorkerResponse,
} from "./anonymize-chat-worker-protocol";

class FakeClock {
  private nextId = 0;
  private readonly tasks = new Map<
    number,
    { callback: () => void; delayMs: number }
  >();

  get activeCount(): number {
    return this.tasks.size;
  }

  schedule = (callback: () => void, delayMs: number) => {
    this.nextId += 1;
    const id = this.nextId;
    this.tasks.set(id, { callback, delayMs });
    return { cancel: () => this.tasks.delete(id) };
  };

  fireNext(): number {
    const entry = this.tasks.entries().next().value;
    if (entry === undefined) {
      throw new Error("Expected a scheduled timeout");
    }
    const [id, task] = entry;
    this.tasks.delete(id);
    task.callback();
    return task.delayMs;
  }
}

type FakeWorkerListenerRegistration =
  | [
      type: "message",
      listener: (event: MessageEvent<AnonymizeChatWorkerResponse>) => void,
    ]
  | [type: "error", listener: (event: ErrorEvent) => void];

class FakeWorker {
  private readonly errorListeners: ((event: ErrorEvent) => void)[] = [];
  private readonly messageListeners: ((
    event: MessageEvent<AnonymizeChatWorkerResponse>,
  ) => void)[] = [];
  readonly postedMessages: AnonymizeChatWorkerRequest[] = [];
  failNextPost: Error | null = null;
  terminated = false;

  emitError(): void {
    const event = new ErrorEvent("error");
    for (const listener of this.errorListeners) {
      listener(event);
    }
  }

  emitMessage(response: AnonymizeChatWorkerResponse): void {
    const event = new MessageEvent("message", { data: response });
    for (const listener of this.messageListeners) {
      listener(event);
    }
  }

  addEventListener = (
    ...registration: FakeWorkerListenerRegistration
  ): void => {
    const [type, listener] = registration;
    if (type === "message") {
      this.messageListeners.push(listener);
      return;
    }
    this.errorListeners.push(listener);
  };

  postMessage(request: AnonymizeChatWorkerRequest): void {
    if (this.failNextPost !== null) {
      const error = this.failNextPost;
      this.failNextPost = null;
      throw error;
    }
    this.postedMessages.push(request);
  }

  terminate(): void {
    this.terminated = true;
  }
}

const RESULT = {
  redactedText: "[PERSON_1]",
  pairs: [
    { placeholder: "[PERSON_1]", original: "Jan Novák", label: "person" },
  ],
  redactionMap: new Map([["[PERSON_1]", "Jan Novák"]]),
  entityCount: 1,
} satisfies ChatAnonResult;

const REQUEST = { text: "Jan Novák", workspaceId: "matter-1" } as const;

const captureRejection = async (promise: Promise<unknown>): Promise<unknown> =>
  await promise.then(
    () => {
      throw new Error("Expected the operation to reject");
    },
    (error: unknown) => error,
  );

const setup = ({ maxPendingRequests = 32 } = {}) => {
  const clock = new FakeClock();
  const workers: FakeWorker[] = [];
  const client = createAnonymizeChatWorkerClient({
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    requestTimeoutMs: 30_000,
    maxPendingRequests,
    scheduleTimeout: clock.schedule,
  });
  return { client, clock, workers };
};

describe("anonymization worker lifecycle", () => {
  test("times out a hung request, terminates its worker, and recreates it", async () => {
    const { client, clock, workers } = setup();
    const first = client.anonymize(REQUEST);
    const firstError = captureRejection(first);

    expect(clock.fireNext()).toBe(30_000);
    const error = await firstError;
    expect(error).toBeInstanceOf(ClientOperationError);
    expect(error).toHaveProperty(
      "message",
      "Anonymization worker request timed out",
    );
    expect(workers.at(0)?.terminated).toBe(true);

    const second = client.anonymize(REQUEST);
    expect(workers).toHaveLength(2);
    workers.at(1)?.emitMessage({ id: 2, ok: true, result: RESULT });
    expect(await second).toBe(RESULT);
  });

  test("clears the request timeout when a response settles", async () => {
    const { client, clock, workers } = setup();
    const response = client.anonymize(REQUEST);
    expect(clock.activeCount).toBe(1);

    workers.at(0)?.emitMessage({ id: 1, ok: true, result: RESULT });

    expect(await response).toBe(RESULT);
    expect(clock.activeCount).toBe(0);
    expect(workers.at(0)?.terminated).toBe(false);
  });

  test("rejects every pending request after a crash and recreates the worker", async () => {
    const { client, clock, workers } = setup();
    const first = client.anonymize(REQUEST);
    const second = client.anonymize(REQUEST);
    const firstError = captureRejection(first);
    const secondError = captureRejection(second);

    workers.at(0)?.emitError();

    const errors = await Promise.all([firstError, secondError]);
    expect(errors).toEqual([
      expect.objectContaining({ message: "Anonymization worker crashed" }),
      expect.objectContaining({ message: "Anonymization worker crashed" }),
    ]);
    expect(errors.every((error) => ClientOperationError.is(error))).toBe(true);
    expect(clock.activeCount).toBe(0);
    expect(workers.at(0)?.terminated).toBe(true);

    const recovered = client.anonymize(REQUEST);
    expect(workers).toHaveLength(2);
    workers.at(1)?.emitMessage({ id: 3, ok: true, result: RESULT });
    expect(await recovered).toBe(RESULT);
  });

  test("cleans up all requests when postMessage throws", async () => {
    const { client, clock, workers } = setup();
    const first = client.anonymize(REQUEST);
    const firstError = captureRejection(first);
    const worker = workers.at(0);
    if (worker === undefined) {
      throw new Error("Expected the client to create a worker");
    }
    worker.failNextPost = new Error("port disconnected");

    const second = client.anonymize(REQUEST);
    const secondError = captureRejection(second);

    const errors = await Promise.all([firstError, secondError]);
    expect(errors.every((error) => ClientOperationError.is(error))).toBe(true);
    expect(errors).toEqual([
      expect.objectContaining({
        message: "Unable to send anonymization request: port disconnected",
      }),
      expect.objectContaining({
        message: "Unable to send anonymization request: port disconnected",
      }),
    ]);
    expect(clock.activeCount).toBe(0);
    expect(worker.terminated).toBe(true);

    const recovered = client.anonymize(REQUEST);
    expect(workers).toHaveLength(2);
    workers.at(1)?.emitMessage({ id: 3, ok: true, result: RESULT });
    expect(await recovered).toBe(RESULT);
  });

  test("rejects overflow without posting or terminating the active worker", async () => {
    const { client, clock, workers } = setup({ maxPendingRequests: 2 });
    const first = client.anonymize(REQUEST);
    const second = client.anonymize(REQUEST);
    const overflow = client.anonymize(REQUEST);

    const overflowError = await captureRejection(overflow);
    expect(overflowError).toBeInstanceOf(ClientOperationError);
    expect(overflowError).toHaveProperty(
      "message",
      "Anonymization worker request queue is full",
    );
    expect(workers.at(0)?.postedMessages).toHaveLength(2);
    expect(workers.at(0)?.terminated).toBe(false);
    expect(clock.activeCount).toBe(2);

    workers.at(0)?.emitMessage({ id: 1, ok: true, result: RESULT });
    workers.at(0)?.emitMessage({ id: 2, ok: true, result: RESULT });
    await Promise.all([first, second]);
  });
});
