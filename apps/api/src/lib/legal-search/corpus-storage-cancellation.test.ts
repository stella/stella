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

const { deleteCorpusDocument, writeCorpusDocument } =
  await import("@/api/lib/legal-search/corpus-storage");

const writeRejection = async (signal: AbortSignal): Promise<unknown> =>
  await writeCorpusDocument(
    {
      documentId: "decision-1",
      jurisdiction: "SVK",
      text: "decision text",
      sections: null,
      ast: null,
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

    while (putCorpusObjectMock.mock.calls.length < 3) {
      await Bun.sleep(1);
    }
    const signals = putCorpusObjectMock.mock.calls.map((call) => call[3]);
    controller.abort();

    const rejection = await pending;

    expect(rejection).toMatchObject({ name: "AbortError" });
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal?.aborted)).toBe(true);
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

    while (deleteCorpusObjectMock.mock.calls.length < 3) {
      await Bun.sleep(1);
    }
    const signals = deleteCorpusObjectMock.mock.calls.map((call) => call[1]);
    controller.abort();

    const rejection = await pending;

    expect(rejection).toMatchObject({ name: "AbortError" });
    expect(signals.every((signal) => signal?.aborted)).toBe(true);
  });
});
