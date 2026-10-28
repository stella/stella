import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { rejectionOf } from "@stll/property-testing/rejection";

import {
  buildChatRequestMessage,
  buildChatTextMessage,
} from "@/features/chat/lib/build-chat-request-message";
import {
  chatDraftHasModelContent,
  EmptyChatMessageError,
} from "@/features/chat/lib/chat-message-model-content";

// Composer HTML of drafts with nothing to read, as the editor serializes them.
const BLANK_COMPOSER_HTML = [
  "",
  "<p></p>",
  "<p> </p>",
  "<p><br></p>",
  "<p>&nbsp;</p>",
  "<p> &nbsp; </p><p></p>",
  '<p><br class="ProseMirror-trailingBreak"></p>',
];

const DECISION_PASSAGE_HTML =
  '<p><pasted-text data-label="1 Afs 2/2020" data-source="paste">Quoted words</pasted-text> <entity-mention data-id="0190f2b4-6a1e-7c2d-9a3b-1c2d3e4f5a6b" data-label="1 Afs 2/2020" data-category="decision" data-kind="decision"></entity-mention> </p>';

const htmlHasContent = (html: string) =>
  chatDraftHasModelContent({ files: [], html });

describe("model content of a composer draft", () => {
  test.each(BLANK_COMPOSER_HTML)(
    "blank composer HTML %p is refused",
    (html) => {
      expect(htmlHasContent(html)).toBe(false);
    },
  );

  test("chips alone are content: the quoted passage and the decision", () => {
    expect(htmlHasContent(DECISION_PASSAGE_HTML)).toBe(true);
    expect(
      htmlHasContent(
        '<p><entity-mention data-id="m1" data-label="Lease" data-category="workspace"></entity-mention> </p>',
      ),
    ).toBe(true);
  });

  test("an attachment or a pasted passage carries a blank paragraph", () => {
    const file = new File(["%PDF"], "lease.pdf", { type: "application/pdf" });
    expect(
      chatDraftHasModelContent({
        files: [
          {
            type: "file",
            file,
            filename: "lease.pdf",
            id: "f1",
            mimeType: "application/pdf",
          },
        ],
        html: "<p> </p>",
      }),
    ).toBe(true);
    expect(
      chatDraftHasModelContent({
        files: [{ type: "pasted_text", id: "p1", text: "Clause 4" }],
        html: "",
      }),
    ).toBe(true);
  });

  test("pasted text is judged as text, never parsed as HTML", () => {
    // Pasted literally, `<b></b>` is seven characters a model reads.
    expect(
      chatDraftHasModelContent({
        files: [{ type: "pasted_text", id: "p1", text: "<b></b>" }],
        html: "",
      }),
    ).toBe(true);
    expect(
      chatDraftHasModelContent({
        files: [{ type: "pasted_text", id: "p1", text: " \n" }],
        html: "",
      }),
    ).toBe(false);
  });

  test("blank HTML stays refused and any visible word makes it content", () => {
    assertProperty(
      "blank HTML stays refused and any visible word makes it content",
      fc.property(
        fc.array(
          fc.constantFrom(
            "<p>",
            "</p>",
            "<br>",
            " ",
            "\n",
            "&nbsp;",
            "&#160;",
            "<p><br></p>",
          ),
        ),
        fc.stringMatching(/^[A-Za-z0-9]+$/u),
        fc.nat(),
        (fragments, word, at) => {
          expect(htmlHasContent(fragments.join(""))).toBe(false);
          const index = at % (fragments.length + 1);
          const withWord = [
            ...fragments.slice(0, index),
            word,
            ...fragments.slice(index),
          ].join("");
          expect(htmlHasContent(withWord)).toBe(true);
        },
      ),
    );
  });
});

describe("building a request message", () => {
  test.each(BLANK_COMPOSER_HTML)(
    "a blank draft %p is refused before anything is read or sent",
    async (html) => {
      const rejection = await rejectionOf(
        buildChatRequestMessage({ files: [], html }),
      );
      expect(EmptyChatMessageError.is(rejection)).toBe(true);
    },
  );

  test("a chips-only draft builds into a message", async () => {
    const message = await buildChatRequestMessage({
      files: [],
      html: DECISION_PASSAGE_HTML,
    });
    expect(message.content).toBe(DECISION_PASSAGE_HTML);
  });

  test("a blank preset text is refused and a real one is built", () => {
    expect(() => buildChatTextMessage(" \n\t")).toThrow(EmptyChatMessageError);
    expect(buildChatTextMessage("Suggest fields").content).toBe(
      "Suggest fields",
    );
  });
});
