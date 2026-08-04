import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ChatAnonPair } from "@stll/anonymize-chat";

import { createChatAnonDecorationOwner } from "./chat-anon-decoration-owner";

const setPairs = mock(
  (_view: object, _pairs: readonly ChatAnonPair[]) => undefined,
);

type TestEditor = { view: object };

const {
  setActive: setActiveChatAnonDecorationOwner,
  updateActive: updateActiveChatAnonDecorationOwner,
} = createChatAnonDecorationOwner((editor: TestEditor, pairs) => {
  setPairs(editor.view, pairs);
});

const anonymizedPairs = [
  {
    label: "person",
    original: "Jan Novák",
    placeholder: "[PERSON_1]",
  },
] as const satisfies readonly ChatAnonPair[];

// The ownership layer only needs an editor identity and forwards its `view` to
// the decoration writer, which this test replaces. A DOM-backed EditorView is
// deliberately outside this state-ownership unit test.
const createEditor = (): TestEditor => ({ view: {} });

describe("chat anonymization decoration ownership", () => {
  beforeEach(() => {
    setPairs.mockClear();
  });

  test("clears anonymized pairs when the focused owner switches to raw mode", () => {
    const editor = createEditor();

    setActiveChatAnonDecorationOwner({
      editor,
      ownerKey: "thread:anonymized",
      pairs: anonymizedPairs,
    });
    setActiveChatAnonDecorationOwner({
      editor,
      ownerKey: "thread:raw",
      pairs: [],
    });

    expect(setPairs).toHaveBeenNthCalledWith(1, editor.view, anonymizedPairs);
    expect(setPairs).toHaveBeenNthCalledWith(2, editor.view, []);
  });

  test("does not let a stale anonymous worker repaint a newly focused composer", () => {
    const editor = createEditor();

    setActiveChatAnonDecorationOwner({
      editor,
      ownerKey: "thread:anonymized",
      pairs: anonymizedPairs,
    });
    setActiveChatAnonDecorationOwner({
      editor,
      ownerKey: "thread:raw",
      pairs: [],
    });
    updateActiveChatAnonDecorationOwner({
      editor,
      ownerKey: "thread:anonymized",
      pairs: anonymizedPairs,
    });

    expect(setPairs).toHaveBeenCalledTimes(2);
    expect(setPairs).toHaveBeenLastCalledWith(editor.view, []);
  });
});
