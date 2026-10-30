import { describe, expect, test } from "bun:test";

import { createChatPastedTextPart } from "@stll/api-contract/chat";

import type { ChatPart } from "@/components/chat/chat-ui-tools";
import {
  buildEditedUserMessage,
  createUserMessageEditDraft,
  userMessageEditHtml,
  userMessageEditText,
} from "@/components/chat/user-message-edit.logic";
import { mentionAttrsToHref } from "@/components/references/reference.logic";

const ENTITY_ID = "018f0000-0000-7000-8000-0000000000d1";
const MATTER_ID = "018f0000-0000-7000-8000-0000000000d2";

const hrefOf = (attrs: Record<string, string>): string =>
  mentionAttrsToHref(attrs) ?? expect.unreachable("A mention href");

describe("the text an edit starts from", () => {
  test("a stored message reads as the text the user typed, references as chips", () => {
    const entityHref = hrefOf({ category: "entity", id: ENTITY_ID });
    const matterHref = hrefOf({ category: "workspace", id: MATTER_ID });
    const registryHref = hrefOf({ category: "registry", id: "ares" });
    const stored = `Compare [NDA.docx](${entityHref}) in [Acme](${matterHref}) with [ARES](${registryHref}), see [the guide](https://example.com/guide) and 2 \\* 3`;

    const editable = userMessageEditText(stored);

    expect(editable.text).toBe(
      "Compare @NDA.docx in @Acme with @ARES, see the guide (https://example.com/guide) and 2 * 3",
    );
    expect(editable.chips).toEqual([
      {
        html: `<entity-mention data-id="${ENTITY_ID}" data-label="NDA.docx" data-category="entity"></entity-mention>`,
        token: "@NDA.docx",
      },
      {
        html: `<entity-mention data-id="${MATTER_ID}" data-label="Acme" data-category="workspace"></entity-mention>`,
        token: "@Acme",
      },
      {
        html: `<entity-mention data-id="ares" data-label="ARES" data-category="registry"></entity-mention>`,
        token: "@ARES",
      },
    ]);
  });

  test("a chip the composer sends back is the one the stored link came from", () => {
    // Each chip's markup, read back as the server reads a composer mention,
    // names the same link the stored message held.
    for (const attrs of [
      { category: "entity", id: ENTITY_ID },
      { category: "entity", id: ENTITY_ID, sourceWorkspaceId: MATTER_ID },
      { category: "workspace", id: MATTER_ID },
      { category: "registry", id: "ares" },
    ]) {
      const href = hrefOf(attrs);
      const [chip] = userMessageEditText(`[Label](${href})`).chips;
      const tag = new Map(
        Array.from(
          (chip?.html ?? "").matchAll(/(?<name>[\w-]+)="(?<value>[^"]*)"/gu),
          (match) => [match.groups?.["name"], match.groups?.["value"]],
        ),
      );
      expect(
        mentionAttrsToHref({
          category: tag.get("data-category"),
          id: tag.get("data-id"),
          sourceWorkspaceId: tag.get("data-source-workspace-id"),
        }),
      ).toBe(href);
    }
  });

  test("a skill link stays the link the composer sends", () => {
    const editable = userMessageEditText(
      "Run [Review](#stella-skill-ref=review) now",
    );
    expect(editable).toEqual({
      chips: [
        {
          html: '<a href="#stella-skill-ref=review">Review</a>',
          token: "@Review",
        },
      ],
      text: "Run @Review now",
    });
  });

  test("paragraphs, lists and line breaks keep their lines", () => {
    expect(
      userMessageEditText("First paragraph\\\nnext line\n\n- one\n- two").text,
    ).toBe("First paragraph\nnext line\n\n- one\n- two");
  });
});

describe("the markup an edit sends", () => {
  test("escapes the text and splits it into paragraphs and lines", () => {
    expect(
      userMessageEditHtml({
        chips: [],
        text: '  a < b & c\nnext\n\n\nlast "quoted"  ',
      }),
    ).toBe("<p>a &lt; b &amp; c<br>next</p><p>last &quot;quoted&quot;</p>");
  });

  test("writes each chip whose token remains back in its place, in order", () => {
    const chips = [
      { html: '<entity-mention data-id="1"></entity-mention>', token: "@A" },
      { html: '<entity-mention data-id="2"></entity-mention>', token: "@B" },
      { html: '<entity-mention data-id="3"></entity-mention>', token: "@A" },
    ];
    expect(userMessageEditHtml({ chips, text: "@A then @A" })).toBe(
      '<p><entity-mention data-id="1"></entity-mention> then <entity-mention data-id="3"></entity-mention></p>',
    );
  });

  test("a chip whose token the user deleted is gone", () => {
    const { chips } = userMessageEditText(
      `Compare [NDA.docx](${hrefOf({ category: "entity", id: ENTITY_ID })})`,
    );
    expect(userMessageEditHtml({ chips, text: "Compare the NDA" })).toBe(
      "<p>Compare the NDA</p>",
    );
  });

  test("a token typed where no chip stood stays text", () => {
    const chip = {
      html: '<entity-mention data-id="1"></entity-mention>',
      token: "@Acme",
    };
    expect(
      userMessageEditHtml({ chips: [chip], text: "@Acme\n\nthen @Acme" }),
    ).toBe(
      '<p><entity-mention data-id="1"></entity-mention></p><p>then @Acme</p>',
    );
    expect(userMessageEditHtml({ chips: [], text: "Ask @Acme" })).toBe(
      "<p>Ask @Acme</p>",
    );
  });
});

describe("the edited message", () => {
  const ndaDocument: ChatPart = {
    metadata: { filename: "nda.pdf" },
    source: { mimeType: "application/pdf", type: "url", value: "/v1/f/1" },
    type: "document",
  };
  const pasted = createChatPastedTextPart("Clause 4");

  test("keeps every attachment of the message under an id for this edit", () => {
    const ids = ["first", "second"];
    const draft = createUserMessageEditDraft(
      { parts: [{ type: "text", content: "Review" }, ndaDocument, pasted] },
      () => ids.shift() ?? expect.unreachable("Two ids"),
    );
    expect(draft).toEqual({
      attachments: [
        { id: "first", part: ndaDocument },
        { id: "second", part: pasted },
      ],
      chips: [],
      text: "Review",
    });
  });

  test("sends the text first and the kept attachments after it", () => {
    expect(
      buildEditedUserMessage({
        draft: {
          attachments: [{ id: "first", part: ndaDocument }],
          chips: [],
          text: "Review",
        },
        messageId: "018f0000-0000-7000-8000-0000000000a2",
      }),
    ).toEqual({
      content: [{ content: "<p>Review</p>", type: "text" }, ndaDocument],
      id: "018f0000-0000-7000-8000-0000000000a2",
    });
  });

  test("sends text alone, or attachments alone", () => {
    expect(
      buildEditedUserMessage({
        draft: { attachments: [], chips: [], text: "Review" },
        messageId: "message",
      }).content,
    ).toBe("<p>Review</p>");
    expect(
      buildEditedUserMessage({
        draft: {
          attachments: [{ id: "first", part: pasted }],
          chips: [],
          text: "  ",
        },
        messageId: "message",
      }).content,
    ).toEqual([pasted]);
  });
});
