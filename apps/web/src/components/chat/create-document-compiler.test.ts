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

  test("does not turn an entire bilingual body paragraph bold", () => {
    const compiled = compileCreateDocumentSourceToDocument(`
@doc kind=agreement locale=cs page=A4
@paragraph
**Přijímající strana chrání Důvěrné informace. / The Receiving Party protects Confidential Information.**
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
      runs.flatMap((run) =>
        run.content.flatMap((content) =>
          content.type === "text" ? [content.text] : [],
        ),
      ),
    ).toEqual([
      "Přijímající strana chrání Důvěrné informace. / The Receiving Party protects Confidential Information.",
    ]);
    expect(runs.some((run) => run.formatting?.bold === true)).toBe(false);
  });
});
