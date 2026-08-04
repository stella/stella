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
        content: [{ type: "text", text: "\\**doslova** a `**kód**`" }],
      },
    ]);
  });
});
