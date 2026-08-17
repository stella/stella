import { EditorState } from "@tiptap/pm/state";
import { describe, expect, test } from "bun:test";
import { Schema } from "prosemirror-model";

import {
  CHAT_DRAFT_ECHO_META,
  updateCarriesDraftEcho,
} from "./chat-editor-echo";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*" },
    text: { inline: true },
  },
});

const state = EditorState.create({ schema });

const userTransaction = () => state.tr.insertText("typed");
const echoTransaction = () =>
  state.tr.insertText("echoed").setMeta(CHAT_DRAFT_ECHO_META, true);

describe("updateCarriesDraftEcho", () => {
  test("a user edit does not read as an echo", () => {
    expect(updateCarriesDraftEcho([userTransaction()])).toBe(false);
  });

  test("detects the echo meta on the primary transaction", () => {
    expect(updateCarriesDraftEcho([echoTransaction()])).toBe(true);
  });

  test("detects the echo meta on an appended transaction", () => {
    // tiptap reports plugin-appended transactions separately from the primary
    // one; an echo hidden among them must still suppress the persist.
    expect(updateCarriesDraftEcho([userTransaction(), echoTransaction()])).toBe(
      true,
    );
  });

  test("ignores unrelated transaction meta", () => {
    expect(updateCarriesDraftEcho([state.tr.setMeta("unrelated", true)])).toBe(
      false,
    );
  });
});
