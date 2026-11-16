import { describe, expect, test } from "bun:test";

import {
  createChatComposerDocument,
  storedUserMessageDocument,
  userMessageComposerContent,
} from "@/components/chat-editor-markdown.logic";
import { mentionAttrsToHref } from "@/components/references/reference.logic";

describe("chat composer Markdown", () => {
  test("represents strong Markdown as a semantic bold mark", () => {
    expect(
      createChatComposerDocument(
        "**Smluvní strany:** Jméno poskytovatele a __příjemce__",
      ),
    ).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Smluvní strany:",
              marks: [{ type: "bold" }],
            },
            { type: "text", text: " Jméno poskytovatele a " },
            {
              type: "text",
              text: "příjemce",
              marks: [{ type: "bold" }],
            },
          ],
        },
      ],
    });
  });

  test("preserves line breaks and unmatched Markdown literally", () => {
    expect(createChatComposerDocument("První **řádek\nDruhý").content).toEqual([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "První **řádek" },
          { type: "hardBreak" },
          { type: "text", text: "Druhý" },
        ],
      },
    ]);
  });

  test("does not format escaped markers or markers inside code spans", () => {
    expect(
      createChatComposerDocument("\\**doslova** a `**kód**`").content,
    ).toEqual([
      {
        type: "paragraph",
        content: [{ type: "text", text: "**doslova** a `**kód**`" }],
      },
    ]);
  });

  test("resolves backslash escapes so model-written prompts hold plain text", () => {
    // The submit boundary escapes `[` again, so a literal backslash in the
    // editor would reach the transcript doubled: `\\[Party Name\\]`.
    const source = String.raw`Use placeholders (e.g., \[Party Name\], \[Effective Date\]) and \*not bold\*.`;
    expect(source).not.toBe(
      "Use placeholders (e.g., [Party Name], [Effective Date]) and *not bold*.",
    );
    expect(createChatComposerDocument(source).content).toEqual([
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Use placeholders (e.g., [Party Name], [Effective Date]) and *not bold*.",
          },
        ],
      },
    ]);
  });

  test("resolves escapes inside bold text and keeps code spans literal", () => {
    const source = "**\\[Party Name\\]** matches `\\(\\d+\\)` and ``a`\\*b``";
    expect(createChatComposerDocument(source).content).toEqual([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "[Party Name]", marks: [{ type: "bold" }] },
          { type: "text", text: " matches `\\(\\d+\\)` and ``a`\\*b``" },
        ],
      },
    ]);
  });
});

describe("a stored user message back in the composer", () => {
  const ENTITY_ID = "018f0000-0000-7000-8000-0000000000d1";
  const MATTER_ID = "018f0000-0000-7000-8000-0000000000d2";

  test("typed numbers, bullets, hashes and quotes at a line start stay text", () => {
    expect(
      storedUserMessageDocument(
        "1. Parties  \n2. Term  \n- note  \n# heading  \n\\> quote  \n---",
      ),
    ).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "1. Parties" },
            { type: "hardBreak" },
            { type: "text", text: "2. Term" },
            { type: "hardBreak" },
            { type: "text", text: "- note" },
            { type: "hardBreak" },
            { type: "text", text: "# heading" },
            { type: "hardBreak" },
            { type: "text", text: "> quote" },
            { type: "hardBreak" },
            { type: "text", text: "---" },
          ],
        },
      ],
    });
  });

  test("paragraphs, bold text, escapes and literal entities read as typed", () => {
    expect(
      storedUserMessageDocument(
        "Review **the 2 \\* 3 draft** &amp; \\<b\\>\n\nSecond `paragraph`",
      ),
    ).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Review " },
            {
              type: "text",
              text: "the 2 * 3 draft",
              marks: [{ type: "bold" }],
            },
            { type: "text", text: " &amp; <b>" },
          ],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Second `paragraph`" }],
        },
      ],
    });
  });

  test("references come back as chips and a skill as its skill chip", () => {
    const entityHref = mentionAttrsToHref({
      category: "entity",
      id: ENTITY_ID,
      sourceWorkspaceId: MATTER_ID,
    });
    const matterHref = mentionAttrsToHref({
      category: "workspace",
      id: MATTER_ID,
    });
    expect(
      storedUserMessageDocument(
        `Wow![NDA.docx](${entityHref ?? ""}) in [Acme](${matterHref ?? ""}) via [Review](#stella-skill-ref=review) and [the terms](https://example.com/terms)`,
      ).content?.at(0)?.content,
    ).toEqual([
      { type: "text", text: "Wow!" },
      {
        type: "mention",
        attrs: {
          category: "entity",
          id: ENTITY_ID,
          kind: "document",
          label: "NDA.docx",
          matterId: MATTER_ID,
          sourceWorkspaceId: MATTER_ID,
        },
      },
      { type: "text", text: " in " },
      {
        type: "mention",
        attrs: {
          category: "workspace",
          id: MATTER_ID,
          kind: "workspace",
          label: "Acme",
        },
      },
      { type: "text", text: " via " },
      {
        type: "pastedText",
        attrs: { label: "Review", source: "skill", text: "review" },
      },
      { type: "text", text: " and " },
      // A link the composer cannot hold stays the text that shows it.
      { type: "text", text: "the terms (https://example.com/terms)" },
    ]);
  });

  test("the composer's own markup loads as it is", () => {
    expect(
      userMessageComposerContent("<p>Just <strong>sent</strong></p>"),
    ).toBe("<p>Just <strong>sent</strong></p>");
    expect(userMessageComposerContent("<https://example.com>")).toEqual(
      storedUserMessageDocument("<https://example.com>"),
    );
  });
});
