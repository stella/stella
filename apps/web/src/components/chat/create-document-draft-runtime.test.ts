import { afterEach, describe, expect, test } from "bun:test";

import {
  __resetCreateDocumentDraftRuntimeForTests,
  beginCreateDocumentDraftPersistence,
  bindCreateDocumentDraftChatThread,
  clearCreateDocumentDraftChatThreadBinding,
  completeCreateDocumentDraft,
  endCreateDocumentDraftPersistence,
  getCreateDocumentDraftPersistence,
  getCreateDocumentDraftRestoration,
  getBoundCreateDocumentDraftChatThreadId,
  prepareCreateDocumentDraft,
  registerCreateDocumentDraftSaver,
  runCreateDocumentOperationWithRetry,
  saveCreateDocumentDraft,
  settleCreateDocumentDraftWithRetry,
} from "@/components/chat/create-document-draft-runtime";
import { toChatThreadId } from "@/lib/chat-thread-ref";

afterEach(() => {
  __resetCreateDocumentDraftRuntimeForTests();
});

const errorMessage = (value: unknown): string =>
  value instanceof Error ? value.message : String(value);

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
  test("keeps a closed draft locked throughout matter persistence", () => {
    const capturedChatThreadId = toChatThreadId("draft-thread");
    expect(
      beginCreateDocumentDraftPersistence({
        boundChatThreadId: capturedChatThreadId,
        toolCallId: "tool-1",
      }),
    ).toEqual({ status: "saving", boundChatThreadId: capturedChatThreadId });
    expect(
      beginCreateDocumentDraftPersistence({
        boundChatThreadId: toChatThreadId("other-thread"),
        toolCallId: "tool-1",
      }),
    ).toEqual({ status: "already-saving" });
    expect(getCreateDocumentDraftPersistence("tool-1")).toEqual({
      status: "saving",
      boundChatThreadId: capturedChatThreadId,
    });

    endCreateDocumentDraftPersistence("tool-1");

    expect(getCreateDocumentDraftPersistence("tool-1")).toEqual({
      status: "idle",
    });
  });

  test("clears the draft persistence lock only when the draft is terminal", () => {
    beginCreateDocumentDraftPersistence({
      boundChatThreadId: null,
      toolCallId: "tool-1",
    });

    completeCreateDocumentDraft("tool-1");

    expect(getCreateDocumentDraftPersistence("tool-1")).toEqual({
      status: "idle",
    });
  });

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

  test("never recompiles the model source after editor serialization fails", async () => {
    const error = new Error("serialization failed");
    let fallbackCalls = 0;
    registerCreateDocumentDraftSaver("tool-1", async () => {
      throw error;
    });

    const prepared = await prepareCreateDocumentDraft({
      toolCallId: "tool-1",
      compileFallback: async () => {
        fallbackCalls += 1;
        return new Uint8Array([9]).buffer;
      },
    });

    expect(prepared.status).toBe("failed");
    expect(fallbackCalls).toBe(0);
  });

  test("keeps edited bytes through nonterminal reads until matter save completes", async () => {
    const edited = new Uint8Array([1, 2, 3]).buffer;
    const original = new Uint8Array([9]).buffer;
    let fallbackCalls = 0;
    registerCreateDocumentDraftSaver("tool-1", async () => edited)();
    const prepare = async () =>
      await prepareCreateDocumentDraft({
        toolCallId: "tool-1",
        compileFallback: async () => {
          fallbackCalls += 1;
          return original;
        },
      });

    expect(await prepare()).toEqual({ status: "ready", buffer: edited });
    expect(await prepare()).toEqual({ status: "ready", buffer: edited });
    expect(fallbackCalls).toBe(0);

    completeCreateDocumentDraft("tool-1");

    expect(await prepare()).toEqual({ status: "ready", buffer: original });
    expect(fallbackCalls).toBe(1);
  });

  test("exposes retained edited bytes for a remounted editor", async () => {
    const edited = new Uint8Array([4, 5, 6]).buffer;
    registerCreateDocumentDraftSaver("tool-1", async () => edited)();

    const restoration = getCreateDocumentDraftRestoration("tool-1");

    expect(restoration).not.toBeNull();
    expect(await restoration).toEqual({ status: "saved", buffer: edited });
  });

  test("restores the last valid bytes but keeps a later serialization failure terminal", async () => {
    const edited = new Uint8Array([4, 5, 6]).buffer;
    const error = new Error("serialization failed");
    registerCreateDocumentDraftSaver("tool-1", async () => edited)();
    registerCreateDocumentDraftSaver("tool-1", async () => {
      throw error;
    });

    expect((await saveCreateDocumentDraft("tool-1")).status).toBe("failed");
    expect(await getCreateDocumentDraftRestoration("tool-1")).toEqual({
      status: "saved",
      buffer: edited,
    });
  });

  test("retains a first unmount serialization failure instead of recompiling", async () => {
    const error = new Error("first serialization failed");
    let fallbackCalls = 0;
    registerCreateDocumentDraftSaver("tool-1", async () => {
      throw error;
    })();

    const restoration = getCreateDocumentDraftRestoration("tool-1");
    if (restoration === null) {
      throw new Error("Expected failed restoration to be retained");
    }
    const restored = await restoration;
    expect(restored.status).toBe("failed");
    if (restored.status === "failed") {
      expect(errorMessage(restored.error)).toContain(error.message);
    }

    const prepared = await prepareCreateDocumentDraft({
      toolCallId: "tool-1",
      compileFallback: async () => {
        fallbackCalls += 1;
        return new Uint8Array([9]).buffer;
      },
    });
    expect(prepared.status).toBe("failed");
    expect(fallbackCalls).toBe(0);
  });

  test("does not turn a retained capture failure into a source fallback", async () => {
    const error = new Error("first serialization failed");
    let fallbackCalls = 0;
    registerCreateDocumentDraftSaver("tool-1", async () => {
      throw error;
    })();
    registerCreateDocumentDraftSaver("tool-1", async () => null)();

    const prepared = await prepareCreateDocumentDraft({
      toolCallId: "tool-1",
      compileFallback: async () => {
        fallbackCalls += 1;
        return new Uint8Array([9]).buffer;
      },
    });
    expect(prepared.status).toBe("failed");
    expect(fallbackCalls).toBe(0);
  });

  test("retains a bound draft chat after its inspector tab closes", () => {
    bindCreateDocumentDraftChatThread({
      chatThreadId: toChatThreadId("draft-thread"),
      toolCallId: "tool-1",
    });

    expect(getBoundCreateDocumentDraftChatThreadId("tool-1")).toBe(
      toChatThreadId("draft-thread"),
    );

    clearCreateDocumentDraftChatThreadBinding("tool-1");

    expect(getBoundCreateDocumentDraftChatThreadId("tool-1")).toBeNull();
  });

  test("preserves every actionable draft snapshot until it becomes terminal", async () => {
    const draftCount = 33;
    const buffers = Array.from(
      { length: draftCount },
      (_, index) => new Uint8Array([index]).buffer,
    );

    for (const [index, buffer] of buffers.entries()) {
      registerCreateDocumentDraftSaver(`tool-${index}`, async () => buffer)();
    }

    const refreshed = new Uint8Array([255]).buffer;
    registerCreateDocumentDraftSaver("tool-0", async () => refreshed)();
    const lastBuffer = buffers.at(-1);
    if (lastBuffer === undefined) {
      throw new Error(
        "Expected the fixed-size snapshot fixture to be non-empty",
      );
    }

    const secondBuffer = buffers.at(1);
    if (secondBuffer === undefined) {
      throw new Error(
        "Expected the draft snapshot fixture to contain two rows",
      );
    }
    expect(await saveCreateDocumentDraft("tool-1")).toEqual({
      status: "saved",
      buffer: secondBuffer,
    });
    expect(await saveCreateDocumentDraft("tool-0")).toEqual({
      status: "saved",
      buffer: refreshed,
    });
    expect(await saveCreateDocumentDraft(`tool-${draftCount - 1}`)).toEqual({
      status: "saved",
      buffer: lastBuffer,
    });
  });

  test("preserves large edited snapshots until their draft becomes terminal", async () => {
    const snapshotBytes = 24 * 1024 * 1024;
    const buffers = Array.from(
      { length: 3 },
      () => new ArrayBuffer(snapshotBytes),
    );
    const saves: ReturnType<typeof saveCreateDocumentDraft>[] = [];
    for (const [index, buffer] of buffers.entries()) {
      registerCreateDocumentDraftSaver(`large-${index}`, async () => buffer)();
      saves.push(saveCreateDocumentDraft(`large-${index}`));
    }
    await Promise.all(saves);

    expect((await saveCreateDocumentDraft("large-0")).status).toBe("saved");
    expect((await saveCreateDocumentDraft("large-1")).status).toBe("saved");
    expect((await saveCreateDocumentDraft("large-2")).status).toBe("saved");
  });
});
