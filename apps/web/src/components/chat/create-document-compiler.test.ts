import { describe, expect, test } from "bun:test";

import { compileCreateDocumentSourceToDocument } from "@/components/chat/create-document-compiler";

describe("create-document compiler", () => {
  test("compiles inline Markdown bold markers into DOCX runs", () => {
    const compiled = compileCreateDocumentSourceToDocument(`
@doc kind=other locale=cs page=A4
@title Plná moc
@paragraph
**Zmocnitel:** Jméno a příjmení
`);
    expect(compiled.status).toBe("ok");
    if (compiled.status !== "ok") {
      return;
    }

    const bodyParagraph = compiled.document.package.document.content.find(
      (block) =>
        block.type === "paragraph" && block.formatting?.styleId === "BodyText",
    );
    expect(bodyParagraph?.type).toBe("paragraph");
    if (bodyParagraph?.type !== "paragraph") {
      return;
    }

    const runs = bodyParagraph.content.filter((part) => part.type === "run");
    expect(
      runs.flatMap((run) =>
        run.content.flatMap((content) =>
          content.type === "text" ? [content.text] : [],
        ),
      ),
    ).toEqual(["Zmocnitel:", " Jméno a příjmení"]);
    expect(runs.at(0)?.formatting?.bold).toBe(true);
    expect(runs.at(1)?.formatting?.bold).not.toBe(true);
  });

  test("preserves unmatched markers as literal text", () => {
    const compiled = compileCreateDocumentSourceToDocument(`
@doc kind=other locale=cs page=A4
@paragraph
Neuzavřená ** značka
`);
    expect(compiled.status).toBe("ok");
    if (compiled.status !== "ok") {
      return;
    }

    const paragraph = compiled.document.package.document.content.find(
      (block) =>
        block.type === "paragraph" && block.formatting?.styleId === "BodyText",
    );
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type !== "paragraph") {
      return;
    }
    const run = paragraph.content.find((part) => part.type === "run");
    const text = run?.content.find((content) => content.type === "text");
    expect(text?.type === "text" ? text.text : null).toBe(
      "Neuzavřená ** značka",
    );
  });
});
