import { describe, expect, mock, test } from "bun:test";

const realS3 = await import("@/api/lib/s3");

const putCorpusObjectMock = mock(
  async (
    _key: string,
    _bytes: Uint8Array,
    _mimeType: string,
    signal: AbortSignal,
  ): Promise<void> => {
    await new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () =>
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new DOMException("Aborted", "AbortError"),
          ),
        { once: true },
      );
    });
  },
);
const deleteCorpusObjectMock = mock(
  async (_key: string, signal: AbortSignal): Promise<void> => {
    await new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () =>
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new DOMException("Aborted", "AbortError"),
          ),
        { once: true },
      );
    });
  },
);

void mock.module("@/api/lib/s3", () => ({
  ...realS3,
  deleteCorpusS3ObjectWithSignal: deleteCorpusObjectMock,
  putCorpusS3ObjectWithSignal: putCorpusObjectMock,
}));

const {
  corpusContentHash,
  corpusKeys,
  deleteCorpusDocument,
  writeCorpusDocument,
} = await import("@/api/lib/legal-search/corpus-storage");
const { EMPTY_AST } = await import("@/api/lib/legal-search/document-types");

const waitForCallCount = async (
  callCount: () => number,
  expected: number,
): Promise<void> => {
  await new Promise<void>((resolve) => {
    const check = () => {
      if (callCount() >= expected) {
        resolve();
        return;
      }
      setTimeout(check, 1);
    };
    check();
  });
};

const writeRejection = async (signal: AbortSignal): Promise<unknown> =>
  await writeCorpusDocument(
    {
      documentId: "decision-1",
      jurisdiction: "SVK",
      text: "decision text",
      sections: null,
      ast: null,
      stored: null,
    },
    { signal },
  ).then(
    () => null,
    (error: unknown) => error,
  );

describe("corpus object cancellation", () => {
  test("does not start a corpus PUT for an already-cancelled owner", async () => {
    const controller = new AbortController();
    controller.abort();

    const rejection = await writeRejection(controller.signal);

    expect(rejection).toMatchObject({ name: "AbortError" });
    expect(putCorpusObjectMock).not.toHaveBeenCalled();
  });

  test("passes caller cancellation to every in-flight corpus PUT", async () => {
    const controller = new AbortController();
    const pending = writeRejection(controller.signal);

    await waitForCallCount(() => putCorpusObjectMock.mock.calls.length, 3);
    const signals = putCorpusObjectMock.mock.calls.map((call) => call[3]);
    controller.abort();

    const rejection = await pending;

    expect(rejection).toMatchObject({ name: "AbortError" });
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  test("waits for aborted sibling PUTs before reporting a write failure", async () => {
    const writeFailure = new Error("text write failed");
    const allWritesStarted = Promise.withResolvers<undefined>();
    const siblingsAborted = Promise.withResolvers<undefined>();
    const releaseSiblings = Promise.withResolvers<undefined>();
    let started = 0;
    let abortedSiblings = 0;

    putCorpusObjectMock.mockImplementation(
      async (
        key: string,
        _bytes: Uint8Array,
        _mimeType: string,
        signal: AbortSignal,
      ): Promise<void> => {
        started += 1;
        if (started === 3) {
          allWritesStarted.resolve(undefined);
        }
        await allWritesStarted.promise;

        if (key.endsWith("/text.zst")) {
          throw writeFailure;
        }

        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              abortedSiblings += 1;
              if (abortedSiblings === 2) {
                siblingsAborted.resolve(undefined);
              }
              const rejectAfterRelease = async () => {
                await releaseSiblings.promise;
                reject(
                  signal.reason instanceof Error
                    ? signal.reason
                    : new DOMException("Aborted", "AbortError"),
                );
              };
              void rejectAfterRelease();
            },
            { once: true },
          );
        });
      },
    );

    const pending = writeRejection(new AbortController().signal);
    await siblingsAborted.promise;

    const earlyState = await Promise.race([
      pending.then(() => "returned" as const),
      Bun.sleep(1).then(() => "pending" as const),
    ]);
    expect(earlyState).toBe("pending");

    releaseSiblings.resolve(undefined);
    expect(await pending).toBe(writeFailure);
  });

  test("passes caller cancellation to every in-flight corpus DELETE", async () => {
    const controller = new AbortController();
    const pending = deleteCorpusDocument(
      {
        textKey: "corpus/text",
        sectionsKey: "corpus/sections",
        astKey: "corpus/ast",
      },
      { signal: controller.signal },
    ).then(
      () => null,
      (error: unknown) => error,
    );

    await waitForCallCount(() => deleteCorpusObjectMock.mock.calls.length, 3);
    const signals = deleteCorpusObjectMock.mock.calls.map((call) => call[1]);
    controller.abort();

    const rejection = await pending;

    expect(rejection).toMatchObject({ name: "AbortError" });
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  test("waits for aborted sibling DELETEs before reporting a delete failure", async () => {
    deleteCorpusObjectMock.mockClear();
    const deleteFailure = new Error("text delete failed");
    const allDeletesStarted = Promise.withResolvers<undefined>();
    const siblingsAborted = Promise.withResolvers<undefined>();
    const releaseSiblings = Promise.withResolvers<undefined>();
    let started = 0;
    let abortedSiblings = 0;

    deleteCorpusObjectMock.mockImplementation(
      async (key: string, signal: AbortSignal): Promise<void> => {
        started += 1;
        if (started === 3) {
          allDeletesStarted.resolve(undefined);
        }
        await allDeletesStarted.promise;

        if (key.endsWith("/text")) {
          throw deleteFailure;
        }

        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              abortedSiblings += 1;
              if (abortedSiblings === 2) {
                siblingsAborted.resolve(undefined);
              }
              const rejectAfterRelease = async () => {
                await releaseSiblings.promise;
                reject(
                  signal.reason instanceof Error
                    ? signal.reason
                    : new DOMException("Aborted", "AbortError"),
                );
              };
              void rejectAfterRelease();
            },
            { once: true },
          );
        });
      },
    );

    const pending = deleteCorpusDocument({
      textKey: "corpus/text",
      sectionsKey: "corpus/sections",
      astKey: "corpus/ast",
    }).then(
      () => null,
      (error: unknown) => error,
    );
    await siblingsAborted.promise;

    const earlyState = await Promise.race([
      pending.then(() => "returned" as const),
      Bun.sleep(1).then(() => "pending" as const),
    ]);
    expect(earlyState).toBe("pending");

    releaseSiblings.resolve(undefined);
    expect(await pending).toBe(deleteFailure);
  });
});

describe("corpus write redundancy refusal", () => {
  const documentId = "7f9b1c34-52ad-4c8e-b1f0-6a2d9e4c8b21";
  const jurisdiction = "SVK";
  const payload = {
    text: "Rozsudok v mene Slovenskej republiky. Súd rozhodol o veci samej.",
    sections: null,
    ast: null,
  };

  test("an empty payload issues no corpus PUTs", async () => {
    putCorpusObjectMock.mockClear();

    const outcome = await writeCorpusDocument({
      documentId,
      jurisdiction,
      // The metadata-first shape: no text, no sections, the empty-AST
      // placeholder an adapter without a document emits.
      text: null,
      sections: null,
      ast: EMPTY_AST,
      stored: null,
    });

    expect(outcome).toEqual({
      type: "skipped-empty",
      written: null,
      contentHash: corpusContentHash({
        text: null,
        sections: null,
        ast: EMPTY_AST,
      }),
    });
    expect(putCorpusObjectMock).not.toHaveBeenCalled();
  });

  test("a payload the row already records issues no corpus PUTs", async () => {
    putCorpusObjectMock.mockClear();
    const contentHash = corpusContentHash(payload);
    const stored = {
      ...corpusKeys({ documentId, jurisdiction, contentHash }),
      contentHash,
    };

    const outcome = await writeCorpusDocument({
      documentId,
      jurisdiction,
      ...payload,
      stored,
    });

    expect(outcome).toEqual({ type: "skipped-unchanged", written: stored });
    expect(putCorpusObjectMock).not.toHaveBeenCalled();
  });

  test("a changed payload still issues all three PUTs", async () => {
    putCorpusObjectMock.mockClear();
    putCorpusObjectMock.mockImplementation(async () => {
      await Promise.resolve();
    });
    const previousHash = corpusContentHash(payload);
    const stored = {
      ...corpusKeys({ documentId, jurisdiction, contentHash: previousHash }),
      contentHash: previousHash,
    };
    const changed = { ...payload, text: `${payload.text} Opravené znenie.` };
    expect(corpusContentHash(changed)).not.toBe(previousHash);

    const outcome = await writeCorpusDocument({
      documentId,
      jurisdiction,
      ...changed,
      stored,
    });

    expect(outcome).toMatchObject({
      type: "written",
      written: { contentHash: corpusContentHash(changed) },
    });
    expect(putCorpusObjectMock).toHaveBeenCalledTimes(3);
  });
});
