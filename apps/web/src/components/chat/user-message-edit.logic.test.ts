import { describe, expect, test } from "bun:test";

import { createChatPastedTextPart } from "@stll/api-contract/chat";

import { storedUserMessageDocument } from "@/components/chat-editor-markdown.logic";
import type { ChatPart } from "@/components/chat/chat-ui-tools";
import {
  buildEditedUserMessage,
  createUserMessageEditDraft,
  hasUserMessageEditContent,
} from "@/components/chat/user-message-edit.logic";

const ndaDocument: ChatPart = {
  metadata: { filename: "nda.pdf" },
  source: { mimeType: "application/pdf", type: "url", value: "/v1/f/1" },
  type: "document",
};
const pasted = createChatPastedTextPart("Clause 4");

describe("the edit form's starting state", () => {
  test("opens a stored message as its composer document, attachments apart", () => {
    const ids = ["first", "second"];
    const draft = createUserMessageEditDraft(
      {
        parts: [
          { type: "text", content: "1. Review **the** NDA" },
          ndaDocument,
          pasted,
        ],
      },
      () => ids.shift() ?? expect.unreachable("Two ids"),
    );
    expect(draft).toEqual({
      attachments: [
        { id: "first", part: ndaDocument },
        { id: "second", part: pasted },
      ],
      content: storedUserMessageDocument("1. Review **the** NDA"),
    });
  });

  test("opens a just-sent message as the composer markup it is", () => {
    expect(
      createUserMessageEditDraft(
        { parts: [{ type: "text", content: "<p>Just sent</p>" }] },
        () => "id",
      ).content,
    ).toBe("<p>Just sent</p>");
  });
});

describe("the edited message", () => {
  test("sends the composer markup first and the kept attachments after it", () => {
    expect(
      buildEditedUserMessage({
        edit: { attachments: [ndaDocument], html: "<p>Review</p>" },
        messageId: "018f0000-0000-7000-8000-0000000000a2",
      }),
    ).toEqual({
      content: [{ content: "<p>Review</p>", type: "text" }, ndaDocument],
      id: "018f0000-0000-7000-8000-0000000000a2",
    });
  });

  test("sends markup alone, or attachments alone", () => {
    expect(
      buildEditedUserMessage({
        edit: { attachments: [], html: "<p>Review</p>" },
        messageId: "message",
      }).content,
    ).toBe("<p>Review</p>");
    expect(
      buildEditedUserMessage({
        edit: { attachments: [pasted], html: "" },
        messageId: "message",
      }).content,
    ).toEqual([pasted]);
  });

  test("has something to send only with markup or an attachment", () => {
    expect(hasUserMessageEditContent({ attachments: [], html: "" })).toBe(
      false,
    );
    expect(
      hasUserMessageEditContent({ attachments: [], html: "<p>x</p>" }),
    ).toBe(true);
    expect(hasUserMessageEditContent({ attachments: [pasted], html: "" })).toBe(
      true,
    );
  });
});
