import { expect, test } from "bun:test";

import { DECISION_PASSAGE_MIME } from "./chat-decision-passage";
import {
  insertCredentialPasteRequest,
  readChatPaste,
} from "./chat-editor-paste.logic";
import { PASTED_TEXT_CHIP_MAX_CHARS } from "./chat-pasted-text";

const clipboard = (data: Record<string, string>, kinds: string[] = []) => ({
  getData: (mime: string) => data[mime] ?? "",
  items: kinds.map((kind) => ({ kind })),
});

for (const html of [
  undefined,
  "<main>Whole thread<button>Technical</button></main>",
]) {
  test(`short paste uses literal text with ${html === undefined ? "no" : "unrelated"} HTML`, () => {
    expect(
      readChatPaste(
        clipboard({
          "text/plain": "**quote** <tag>\r\nnext\n",
          ...(html === undefined ? {} : { "text/html": html }),
        }),
      ),
    ).toEqual({
      type: "text",
      content: [
        { type: "text", text: "**quote** <tag>" },
        { type: "hardBreak" },
        { type: "text", text: "next" },
        { type: "hardBreak" },
      ],
    });
  });
  test(`long paste collapses only plain text with ${html === undefined ? "no" : "unrelated"} HTML`, () => {
    const text = "x".repeat(PASTED_TEXT_CHIP_MAX_CHARS + 1);
    expect(
      readChatPaste(
        clipboard({
          "text/plain": text,
          ...(html === undefined ? {} : { "text/html": html }),
        }),
      ),
    ).toEqual({ type: "chip", text });
  });
}

test("HTML-only, empty and unavailable clipboards never fall through", () => {
  expect(
    readChatPaste(clipboard({ "text/html": "<main>Whole thread</main>" })),
  ).toEqual({ type: "ignore" });
  expect(readChatPaste(clipboard({}))).toEqual({ type: "ignore" });
  expect(readChatPaste(null)).toEqual({ type: "ignore" });
});

test("holds a synthetic credential-shaped paste out of the composer draft", () => {
  expect(
    readChatPaste(clipboard({ "text/plain": `sk-${"a".repeat(32)}` })),
  ).toEqual({ type: "credential" });
});

test("inserts a neutral private-card request into a nonempty draft at the cursor", () => {
  let draft = "Review this connector and continue";
  const cursor = "Review this connector".length;
  const editor = {
    isDestroyed: false,
    commands: {
      insertContent: (content: string) => {
        draft = `${draft.slice(0, cursor)}${content}${draft.slice(cursor)}`;
        return true;
      },
    },
  } satisfies Parameters<typeof insertCredentialPasteRequest>[0];

  expect(
    insertCredentialPasteRequest(
      editor,
      " Please request this credential using a private card.",
    ),
  ).toBe(true);
  expect(draft).toBe(
    "Review this connector Please request this credential using a private card. and continue",
  );
});

const passage = {
  caseNumber: "Case 123",
  court: "Court",
  decisionId: "123",
  quote: "Selected passage",
};

test("typed decision passages preserve their reference rather than reading HTML", () => {
  expect(
    readChatPaste(
      clipboard({
        [DECISION_PASSAGE_MIME]: JSON.stringify(passage),
        "text/plain": passage.quote,
        "text/html": "<main>Whole thread</main>",
      }),
    ),
  ).toEqual({ type: "decision", passage });
});

test("malformed typed data falls back only to plain text", () => {
  expect(
    readChatPaste(
      clipboard({ [DECISION_PASSAGE_MIME]: "invalid", "text/plain": "quote" }),
    ),
  ).toEqual({ type: "text", content: [{ type: "text", text: "quote" }] });
  expect(
    readChatPaste(
      clipboard({
        [DECISION_PASSAGE_MIME]: "invalid",
        "text/html": "<main>Whole thread</main>",
      }),
    ),
  ).toEqual({ type: "ignore" });
});

test("files retain upload ownership even alongside text, HTML or typed passages", () => {
  expect(
    readChatPaste(
      clipboard(
        {
          [DECISION_PASSAGE_MIME]: JSON.stringify(passage),
          "text/plain": "quote",
          "text/html": "<main>Whole thread</main>",
        },
        ["string", "file"],
      ),
    ),
  ).toEqual({ type: "files" });
});
