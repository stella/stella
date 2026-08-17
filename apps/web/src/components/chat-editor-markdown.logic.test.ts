import { describe, expect, test } from "bun:test";

import { createChatComposerDocument } from "@/components/chat-editor-markdown.logic";

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
    const source =
      `${String.raw`**\[Party Name\]** matches `  }\`\\(\\d+\\)\` and \`\`a\`\\*b\`\``;
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
