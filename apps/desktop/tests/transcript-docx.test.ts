import { Result } from "better-result";
import { beforeEach, expect, mock, test } from "bun:test";

const invokeMock = mock(
  async (..._call: [command: string, bytes: unknown, options: unknown]) =>
    await Promise.resolve(true),
);

// The module registry is shared across test files, so the replacement keeps
// every real export and overrides only what this file asserts on.
const actualCore = { ...(await import("@tauri-apps/api/core")) };
await mock.module("@tauri-apps/api/core", () => ({
  ...actualCore,
  invoke: invokeMock,
}));

const { buildTranscriptDocx, saveTranscriptDocx } =
  await import("../src/transcribe/transcript-docx");

beforeEach(() => {
  invokeMock.mockClear();
});

const isZip = (bytes: Uint8Array) => bytes[0] === 0x50 && bytes[1] === 0x4b;

test("the raw transcript and the cleaned-up text are built as Word documents", async () => {
  const raw = Result.unwrap(
    await buildTranscriptDocx({
      kind: "raw",
      title: "Diktát – odpověď na mail",
      paragraphs: [{ startMs: 61_000, text: "Dobrý den." }],
    }),
  );
  expect(isZip(raw)).toBe(true);
  const cleaned = Result.unwrap(
    await buildTranscriptDocx({
      kind: "cleaned",
      markdown: "## Odpověď\n\nDobrý den, **děkuji**.\n\n- první",
      instructions: ["Udělej z toho e-mail."],
      instructionsLabel: "Pokyny k diktátu:",
    }),
  );
  expect(isZip(cleaned)).toBe(true);
});

test("saving hands the bytes and the suggested name to the native save", async () => {
  const saved = await saveTranscriptDocx(
    {
      kind: "raw",
      title: "Memo",
      paragraphs: [{ startMs: 0, text: "First." }],
    },
    "Diktát – přepis.docx",
  );
  expect(Result.unwrap(saved)).toBe(true);
  const [command, bytes, options] = invokeMock.mock.calls.at(0) ?? [];
  expect(command).toBe("transcribe_save_docx");
  expect(bytes instanceof Uint8Array && isZip(bytes)).toBe(true);
  expect(options).toEqual({
    headers: {
      "x-stella-file-name": encodeURIComponent("Diktát – přepis.docx"),
    },
  });
});
