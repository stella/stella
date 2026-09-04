import { describe, expect, test } from "bun:test";

import { isPageTransformRequest } from "./page-editor-protocol";
import { transformPDFInWorker } from "./page-editor-worker-client";

class FakeWorker {
  private readonly errorListeners: (() => void)[] = [];
  private readonly messageListeners: ((
    event: MessageEvent<unknown>,
  ) => void)[] = [];
  postedMessage: unknown;
  transferables: readonly unknown[] = [];
  terminated = false;

  addEventListener(
    type: string,
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    if (type === "message") {
      this.messageListeners.push(listener);
      return;
    }
    if (type === "error") {
      this.errorListeners.push(() => listener(new MessageEvent("error")));
    }
  }

  emitError(): void {
    for (const listener of this.errorListeners) {
      listener();
    }
  }

  emitMessage(data: unknown): void {
    for (const listener of this.messageListeners) {
      listener(new MessageEvent("message", { data }));
    }
  }

  postMessage(message: unknown, transferables: readonly unknown[]): void {
    this.postedMessage = message;
    this.transferables = transferables;
  }

  terminate(): void {
    this.terminated = true;
  }
}

const withFakeWorker = async (
  run: (worker: FakeWorker) => Promise<void>,
): Promise<void> => {
  const worker = new FakeWorker();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: function value() {
      return worker;
    },
  });
  try {
    await run(worker);
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, "Worker", descriptor);
    } else {
      Reflect.deleteProperty(globalThis, "Worker");
    }
  }
};

const request = async (signal: AbortSignal, sourceBytes = new ArrayBuffer(8)) =>
  await transformPDFInWorker({
    sources: [{ id: "source", bytes: sourceBytes }],
    pages: [
      {
        id: "page",
        sourceId: "source",
        sourcePageIndex: 0,
        rotation: 0,
      },
    ],
    outputs: [["page"]],
    signal,
  });

describe("PDF page editor worker boundary", () => {
  test("rejects an already-aborted operation before creating a worker", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(request(controller.signal)).rejects.toThrow(
      "PDF transformation cancelled",
    );
  });

  test("transfers copied source buffers and preserves the caller's bytes", async () => {
    await withFakeWorker(async (worker) => {
      const sourceBytes = new ArrayBuffer(8);
      new Uint8Array(sourceBytes)[0] = 42;
      const promise = request(new AbortController().signal, sourceBytes);
      if (!isPageTransformRequest(worker.postedMessage)) {
        throw new Error("Expected a valid worker request");
      }
      const transferred = worker.postedMessage.sources.at(0)?.bytes;
      expect(transferred).toBeInstanceOf(ArrayBuffer);
      expect(transferred).not.toBe(sourceBytes);
      expect(worker.transferables).toEqual([transferred]);
      expect(new Uint8Array(sourceBytes)[0]).toBe(42);

      const output = new ArrayBuffer(4);
      worker.emitMessage({
        requestId: worker.postedMessage.requestId,
        status: "success",
        outputs: [output],
      });
      expect(await promise).toEqual([output]);
      expect(worker.terminated).toBe(true);
    });
  });

  test("rejects invalid responses and worker failures", async () => {
    await withFakeWorker(async (worker) => {
      const promise = request(new AbortController().signal);
      worker.emitMessage({ status: "success", outputs: [] });
      expect(promise).rejects.toThrow("invalid response");
      expect(worker.terminated).toBe(true);
    });

    await withFakeWorker(async (worker) => {
      const promise = request(new AbortController().signal);
      worker.emitError();
      expect(promise).rejects.toThrow("worker failed");
      expect(worker.terminated).toBe(true);
    });
  });

  test("terminates an active worker when the operation is aborted", async () => {
    await withFakeWorker(async (worker) => {
      const controller = new AbortController();
      const promise = request(controller.signal);
      controller.abort();
      expect(promise).rejects.toThrow("PDF transformation cancelled");
      expect(worker.terminated).toBe(true);
    });
  });
});
