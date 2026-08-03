import { afterEach, describe, expect, test } from "bun:test";

import {
  __resetCreateDocumentDraftRuntimeForTests,
  registerCreateDocumentDraftSaver,
  runCreateDocumentOperationWithRetry,
  saveCreateDocumentDraft,
  settleCreateDocumentDraftWithRetry,
} from "@/components/chat/create-document-draft-runtime";

afterEach(() => {
  __resetCreateDocumentDraftRuntimeForTests();
});

describe("create-document settlement retries", () => {
  test("settles after a transient failure without relying on a rerender", async () => {
    let attempts = 0;
    const result = await settleCreateDocumentDraftWithRetry({
      isActive: () => true,
      settle: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("transient");
        }
      },
      wait: async () => {},
    });

    expect(result).toEqual({ status: "settled" });
    expect(attempts).toBe(2);
  });

  test("caps persistent failures", async () => {
    let attempts = 0;
    const error = new Error("persistent");
    const result = await settleCreateDocumentDraftWithRetry({
      isActive: () => true,
      settle: async () => {
        attempts += 1;
        throw error;
      },
      wait: async () => {},
    });

    expect(result.status).toBe("failed");
    expect(attempts).toBe(3);
  });

  test("does not resume a cancelled draft", async () => {
    let active = true;
    let attempts = 0;
    const result = await settleCreateDocumentDraftWithRetry({
      isActive: () => active,
      settle: async () => {
        attempts += 1;
        active = false;
        throw new Error("transient");
      },
      wait: async () => {},
    });

    expect(result).toEqual({ status: "cancelled" });
    expect(attempts).toBe(1);
  });
});

describe("create-document operation retries", () => {
  test("retries an idempotent post-settlement operation", async () => {
    let attempts = 0;
    const result = await runCreateDocumentOperationWithRetry({
      isActive: () => true,
      operation: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("transient");
        }
      },
      wait: async () => {},
    });

    expect(result).toEqual({ status: "completed" });
    expect(attempts).toBe(3);
  });
});

describe("create-document draft runtime", () => {
  test("retains the latest editor bytes when the editor unmounts", async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const unregister = registerCreateDocumentDraftSaver(
      "tool-1",
      async () => bytes,
    );

    unregister();

    expect(await saveCreateDocumentDraft("tool-1")).toEqual({
      status: "saved",
      buffer: bytes,
    });
  });

  test("turns saver rejection into an explicit recoverable result", async () => {
    const error = new Error("serialization failed");
    registerCreateDocumentDraftSaver("tool-1", async () => {
      throw error;
    });

    expect((await saveCreateDocumentDraft("tool-1")).status).toBe("failed");
  });
});
