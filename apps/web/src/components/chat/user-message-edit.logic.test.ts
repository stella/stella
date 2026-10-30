import { describe, expect, test } from "bun:test";

import { createChatPastedTextPart } from "@stll/api-contract/chat";

import type { ChatPart } from "@/components/chat/chat-ui-tools";
import {
  buildEditedUserMessage,
  composeUserMessageEdit,
  createUserMessageEditDraft,
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

  test("a stored message opening with an autolink keeps its URL", () => {
    expect(
      userMessageEditText("<https://example.com/terms> has the terms"),
    ).toEqual({
      chips: [],
      text: "https://example.com/terms has the terms",
    });
  });

  test("a stored message opening with a literal < keeps its text", () => {
    expect(userMessageEditText("<3 thanks for the draft").text).toBe(
      "<3 thanks for the draft",
    );
    // The server stores a typed tag escaped; it reads back as typed.
    expect(userMessageEditText("\\<p> is the paragraph tag").text).toBe(
      "<p> is the paragraph tag",
    );
  });

  test("paragraphs, lists and line breaks keep their lines", () => {
    expect(
      userMessageEditText("First paragraph\\\nnext line\n\n- one\n- two").text,
    ).toBe("First paragraph\nnext line\n\n- one\n- two");
  });
});

describe("the markup an edit sends", () => {
  const MENTION_A = '<entity-mention data-id="a"></entity-mention>';
  const MENTION_B = '<entity-mention data-id="b"></entity-mention>';
  const chipA = { html: MENTION_A, token: "@A" };
  const chipB = { html: MENTION_B, token: "@B" };

  test("escapes the text and splits it into paragraphs and lines", () => {
    expect(
      composeUserMessageEdit({
        chips: [],
        text: '  a < b & c\nnext\n\n\nlast "quoted"  ',
      }),
    ).toEqual({
      html: "<p>a &lt; b &amp; c<br>next</p><p>last &quot;quoted&quot;</p>",
      removedChips: [],
    });
  });

  test("reordering two chips keeps both references, each where it now stands", () => {
    expect(
      composeUserMessageEdit({ chips: [chipA, chipB], text: "@B then @A" }),
    ).toEqual({
      html: `<p>${MENTION_B} then ${MENTION_A}</p>`,
      removedChips: [],
    });
  });

  test("deleting one chip's token removes only that reference", () => {
    expect(
      composeUserMessageEdit({ chips: [chipA, chipB], text: "Only @B now" }),
    ).toEqual({
      html: `<p>Only ${MENTION_B} now</p>`,
      removedChips: [chipA],
    });
  });

  test("a longer token is not read as the shorter one it starts with", () => {
    const acme = { html: MENTION_A, token: "@Acme" };
    const acmeCorp = { html: MENTION_B, token: "@Acme Corp" };
    expect(
      composeUserMessageEdit({
        chips: [acme, acmeCorp],
        text: "@Acme Corp and @Acme",
      }).html,
    ).toBe(`<p>${MENTION_B} and ${MENTION_A}</p>`);
  });

  test("two references with one label keep their own tokens through a reorder", () => {
    const first = hrefOf({ category: "entity", id: ENTITY_ID });
    const second = hrefOf({ category: "workspace", id: MATTER_ID });
    const editable = userMessageEditText(
      `[Acme](${first}) beside [Acme](${second})`,
    );
    expect(editable.text).toBe("@Acme beside @Acme (2)");
    const [entityChip, matterChip] = editable.chips;
    expect(
      composeUserMessageEdit({
        chips: editable.chips,
        text: "@Acme (2) beside @Acme",
      }).html,
    ).toBe(`<p>${matterChip?.html ?? ""} beside ${entityChip?.html ?? ""}</p>`);
  });

  test("a token typed again where no chip stood stays text", () => {
    expect(
      composeUserMessageEdit({ chips: [chipA], text: "@A\n\nthen @A" }).html,
    ).toBe(`<p>${MENTION_A}</p><p>then @A</p>`);
    expect(composeUserMessageEdit({ chips: [], text: "Ask @A" }).html).toBe(
      "<p>Ask @A</p>",
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
