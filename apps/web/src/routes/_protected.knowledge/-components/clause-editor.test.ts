import { describe, expect, test } from "bun:test";

import { mergeEditedBody } from "./clause-editor";
import type { ClauseParagraph } from "./clause-editor-types";

const directive = (
  directiveKind: NonNullable<ClauseParagraph["directiveKind"]>,
  directiveExpression: string,
): ClauseParagraph => ({
  text: `{{#${directiveKind} ${directiveExpression}}}`.trim(),
  isDirective: true,
  directiveKind,
  directiveExpression,
});

describe("mergeEditedBody", () => {
  test("preserves directive paragraphs at their positions on save", () => {
    const original: ClauseParagraph[] = [
      directive("if", "is_company"),
      { text: "Company clause" },
      directive("else", ""),
      { text: "Individual clause" },
      directive("endif", ""),
    ];
    const edited: ClauseParagraph[] = [
      { text: "Company clause EDITED" },
      { text: "Individual clause EDITED" },
    ];

    expect(mergeEditedBody(original, edited)).toEqual([
      directive("if", "is_company"),
      { text: "Company clause EDITED" },
      directive("else", ""),
      { text: "Individual clause EDITED" },
      directive("endif", ""),
    ]);
  });

  test("appends paragraphs added beyond the original non-directive count", () => {
    const original: ClauseParagraph[] = [
      directive("if", "x"),
      { text: "A" },
      directive("endif", ""),
    ];
    const edited: ClauseParagraph[] = [
      { text: "A2" },
      { text: "B (newly added)" },
    ];

    expect(mergeEditedBody(original, edited)).toEqual([
      directive("if", "x"),
      { text: "A2" },
      directive("endif", ""),
      { text: "B (newly added)" },
    ]);
  });

  test("drops original non-directive slots the user removed, keeps directives", () => {
    const original: ClauseParagraph[] = [
      directive("each", "items"),
      { text: "Row one" },
      { text: "Row two" },
      directive("endeach", ""),
    ];
    const edited: ClauseParagraph[] = [{ text: "Row one only" }];

    expect(mergeEditedBody(original, edited)).toEqual([
      directive("each", "items"),
      { text: "Row one only" },
      directive("endeach", ""),
    ]);
  });

  test("no directives → returns the edited body unchanged", () => {
    const edited: ClauseParagraph[] = [{ text: "one" }, { text: "two" }];
    expect(mergeEditedBody([{ text: "old" }], edited)).toEqual(edited);
  });
});
