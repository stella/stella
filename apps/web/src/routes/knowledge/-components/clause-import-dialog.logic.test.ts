import { describe, expect, test } from "bun:test";

import { getClauseImportPreviewCount } from "./clause-import-dialog.logic";

describe("clause import preview", () => {
  test("counts quoted multiline CSV bodies as one clause", () => {
    const csv = [
      "slug,title,body,tags",
      'first,First,"Paragraph one\nParagraph two","tag1,tag2"',
    ].join("\n");

    expect(getClauseImportPreviewCount(csv, "clauses.csv")).toBe(1);
  });

  test("returns zero for malformed quoted CSV", () => {
    const csv = [
      "slug,title,body,tags",
      'first,First,"Paragraph one',
      "second,Second,Paragraph two,tag",
    ].join("\n");

    expect(getClauseImportPreviewCount(csv, "clauses.csv")).toBe(0);
  });

  test("counts clauses in JSON exports", () => {
    expect(
      getClauseImportPreviewCount(
        JSON.stringify({ clauses: [{}, {}] }),
        "clauses.json",
      ),
    ).toBe(2);
  });
});
