import { describe, expect, test } from "bun:test";

import { createChatPastedTextPart } from "@stll/api-contract/chat";

import { storedUserMessageDocument } from "@/components/chat-editor-markdown.logic";
import {
  buildEditedUserMessage,
  createUserMessageEditDraft,
  createUserMessageEditSessions,
  hasUserMessageEditContent,
} from "@/components/chat/user-message-edit.logic";
import type { UserMessageEditAttachmentPart } from "@/components/chat/user-message-edit.logic";
import { toSafeId } from "@/lib/safe-id";
import { createUuid } from "@/lib/uuid";

const ndaDocument: UserMessageEditAttachmentPart = {
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
      id: toSafeId<"chatMessage">("018f0000-0000-7000-8000-0000000000a2"),
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

describe("the edit sessions of a message", () => {
  test("only the current session's continuations run", () => {
    const ids = ["first", "second"];
    const sessions = createUserMessageEditSessions(
      () => ids.shift() ?? expect.unreachable("Two ids"),
    );
    const ran: string[] = [];

    const first = sessions.open("message");
    first.end();
    const second = sessions.open("message");
    first.run(() => {
      ran.push("first");
    });
    second.run(() => {
      ran.push("second");
    });
    // A late end of a retired session leaves the current one current.
    first.end();
    second.run(() => {
      ran.push("second again");
    });
    second.end();
    second.run(() => {
      ran.push("after end");
    });

    expect(ran).toEqual(["second", "second again"]);
  });

  test("a current session whose message left the thread is taken once, with its latest draft", async () => {
    const sessions = createUserMessageEditSessions(createUuid);
    const open = sessions.open("gone");
    open.mirror({ attachments: [], html: "<p>First</p>" });
    open.mirror({ attachments: [pasted], html: "<p>Latest</p>" });
    const kept = sessions.open("kept");
    kept.mirror({ attachments: [], html: "<p>Kept</p>" });
    // A cancelled session is no longer current and never handed on.
    sessions.open("cancelled").end();

    // While its request is out the thread is rewound: not an orphan yet.
    const answered = Promise.withResolvers<undefined>();
    const sending = sessions.whileSending(open, async () => {
      await answered.promise;
    });
    expect(sessions.takeOrphans(new Set(["kept"]))).toEqual([]);
    answered.resolve(undefined);
    await sending;

    expect(sessions.takeOrphans(new Set(["kept"]))).toEqual([
      { attachments: [pasted], html: "<p>Latest</p>" },
    ]);
    expect(sessions.takeOrphans(new Set(["kept"]))).toEqual([]);
    let ranOrphaned = false;
    open.run(() => {
      ranOrphaned = true;
    });
    expect(ranOrphaned).toBe(false);
    expect(sessions.hasOpen()).toBe(true);
  });
});
