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

  test("compiles bold spanning a highlighted placeholder without leaking markers", () => {
    const compiled = compileCreateDocumentSourceToDocument(`
@doc kind=other locale=cs page=A4
@paragraph
**[[Název/Jméno poskytovatele]]** se sídlem: [[Adresa poskytovatele]]
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

    const runs = paragraph.content.filter((part) => part.type === "run");
    const text = runs.flatMap((run) =>
      run.content.flatMap((item) => (item.type === "text" ? [item.text] : [])),
    );
    expect(text.join("")).toBe(
      "Název/Jméno poskytovatele se sídlem: Adresa poskytovatele",
    );
    expect(text.join("")).not.toContain("**");
    expect(runs.at(0)?.formatting?.bold).toBe(true);
    expect(runs.at(0)?.formatting?.highlight).toBe("yellow");
    expect(runs.at(1)?.formatting?.bold).not.toBe(true);
  });

  test("keeps an entire bilingual body paragraph bold as written and reports it", () => {
    const compiled = compileCreateDocumentSourceToDocument(`
@doc kind=agreement locale=cs page=A4
@paragraph
**Přijímající strana chrání Důvěrné informace. / The Receiving Party protects Confidential Information.**
`);
    expect(compiled.status).toBe("ok");
    if (compiled.status !== "ok") {
      return;
    }

    // Nothing is rewritten behind the model's back: the compiler renders
    // the emphasis and flags it, and the warning travels with the tool
    // result so the model can reissue the source.
    expect(compiled.warnings.map((warning) => warning.code)).toContain(
      "whole-paragraph-emphasis",
    );
    const paragraph = compiled.document.package.document.content.find(
      (block) =>
        block.type === "paragraph" && block.formatting?.styleId === "BodyText",
    );
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type !== "paragraph") {
      return;
    }
    const runs = paragraph.content.filter((part) => part.type === "run");
    expect(runs.every((run) => run.formatting?.bold === true)).toBe(true);
  });

  test("preserves separate bold spans that cover an entire paragraph", () => {
    const compiled = compileCreateDocumentSourceToDocument(`
@doc kind=other locale=en page=A4
@paragraph
**Buyer** and **Seller**
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

    const runs = paragraph.content.filter((part) => part.type === "run");
    expect(
      runs.map((run) => ({
        bold: run.formatting?.bold === true,
        text: run.content
          .filter((content) => content.type === "text")
          .map((content) => content.text)
          .join(""),
      })),
    ).toEqual([
      { bold: true, text: "Buyer" },
      { bold: false, text: " and " },
      { bold: true, text: "Seller" },
    ]);
  });
});
