import { Result } from "better-result";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { opinionRow } from "@/api/handlers/case-law/ingestion/adapters/courtlistener/test-records";
import { extractDecisionCitations } from "@/api/handlers/case-law/ingestion/citation-extractor";

import { composeCourtListenerText } from "./compose";

const compose = (html: string, id = "9109419") => {
  const result = composeCourtListenerText([
    {
      row: opinionRow({ id, xml_harvard: "", html_with_citations: html }),
      type: "020lead",
    },
  ]);
  if (result.status !== "parsed")
    throw new TypeError(`expected parsed: ${result.status}`);
  return result;
};
const citations = (text: ReturnType<typeof compose>) => {
  const result = extractDecisionCitations({
    country: "USA",
    sections: text.sections,
    citationScopes: text.citationScopes,
    documentAst: {
      version: 1,
      source: {
        system: "courtlistener",
        documentId: "fixture",
        webUrl: "",
        printUrl: "",
      },
      metadata: {
        caseNumber: null,
        ecli: null,
        court: null,
        decisionDate: null,
        decisionType: null,
        keywords: [],
        statutes: [],
      },
      blocks: [...text.blocks],
    },
  });
  if (Result.isError(result)) throw new TypeError(result.error.message);
  return result.value;
};

const splitNote = `<p>Roe v. Wade, 410 U.S. 113 (1973).<sup id="ref-fn1"><a href="#fn1">1</a></sup></p><p><footnote_body><sup id="fn1"><a href="#ref-fn1">1</a></sup> Compare Brown, 347 U.S. 483 (1954), which provides:</p><p><blockquote>A quoted passage.</blockquote></p><p>Id. at 495 explains the rule.</footnote_body></p>`;
test("a source note spanning repaired HTML paragraphs cannot resolve Id against body text", () => {
  const text = compose(splitNote);
  expect(text.blocks.at(-1)?.plainText).toBe("Id. at 495 explains the rule.");
  expect(
    text.citationScopes.every((scope) => scope.boundaries === "unproven"),
  ).toBe(true);
  const result = citations(text);
  expect(result.occurrences.filter((item) => item.form === "id")).toMatchObject(
    [{ target: { status: "unresolved", reason: "scope-unknown" } }],
  );
});
for (const { cluster, opinion, spans } of [
  {
    cluster: "3256685",
    opinion: "3258941",
    spans: [
      {
        block: "b47",
        prefix: "Circuit Court are established as the trial courts",
      },
      {
        block: "b48",
        prefix: "District courts, which are the successors of municipal courts",
      },
    ],
  },
  {
    cluster: "3260857",
    opinion: "3263113",
    spans: [
      {
        block: "b32",
        prefix:
          "Except as otherwise specifically provided by law, all meetings",
      },
    ],
  },
]) {
  test(`real Columbia ${cluster} note continuation has no proven body scope`, () => {
    const html = readFileSync(
      new URL(
        `./__fixtures__/html/html-with-citations-${cluster}.html`,
        import.meta.url,
      ),
      "utf8",
    );
    const text = compose(html, opinion);
    for (const { block, prefix } of spans) {
      const continuation = text.blocks.find(
        ({ id }) => id === `o${opinion}-${block}`,
      );
      expect(continuation?.plainText.startsWith(prefix)).toBe(true);
      expect(
        text.citationScopes.find((scope) =>
          scope.blockIds.includes(continuation?.id ?? ""),
        ),
      ).toMatchObject({
        opinionId: `cl-opinion:${opinion}/block-${block.slice(1)}`,
        boundaries: "unproven",
      });
    }
    expect(text.principal.body).toBe("");
    expect(text.opinions[0]?.counts?.noteSpanDefects).toBeGreaterThan(0);
    expect(
      text.citationScopes.every((scope) => scope.boundaries === "unproven"),
    ).toBe(true);
    expect(
      citations(text).occurrences.filter(
        (item) => item.target.status === "identified" && item.form === "id",
      ),
    ).toEqual([]);
  });
}
test("only a note's reciprocal mark is removed, not in-note cross-references", () => {
  const text = compose(
    `<p>Body.<sup id="ref-fn2"><a href="#fn2">2</a></sup></p><p><footnote_body><sup id="fn2"><a href="#ref-fn2">2</a></sup> See note <a class="footnote" href="#fn3">3</a>, supra, and <a href="#ref-fn1">the text accompanying note 1</a>.</footnote_body></p>`,
  );
  expect(text.blocks.at(-1)?.plainText).toBe(
    "See note 3, supra, and the text accompanying note 1.",
  );
});
test("empty fragment links cannot label anonymous notes", () => {
  const text = compose(
    `<a href="#">Top</a><p><footnote_body>Unlabelled note.</footnote_body></p>`,
  );
  expect(text.blocks.at(-1)).toMatchObject({ note: { label: "" } });
});

test("a detached note's table stays in one contiguous citation scope", () => {
  const text = compose(
    `<div class="courtcasedocbody"><div class="opinion" opiniontype="majority"><p>Roe v. Wade, 410 U.S. 113 (1973).</p></div></div><div class="footnotes"><div id="fn_1" label="1"><p>Brown, 347 U.S. 483 (1954).</p><table><tr><td>163 U.S. 537. Id. at 539.</td></tr></table><p>Id. at 495.</p></div></div>`,
  );
  const noteBlocks = text.blocks.filter(
    (block) => "note" in block && block.note !== undefined,
  );
  expect(noteBlocks.map((block) => block.type)).toEqual([
    "paragraph",
    "table",
    "paragraph",
  ]);
  expect(text.citationScopes.at(-1)).toMatchObject({
    blockIds: noteBlocks.map((block) => block.id),
    boundaries: "proven",
  });
  const extracted = citations(text);
  expect(
    extracted.occurrences
      .filter((occurrence) => occurrence.form === "id")
      .map(({ noteId, target }) => ({ noteId, target })),
  ).toEqual([
    {
      noteId: "o9109419-fn1",
      target: {
        status: "identified",
        identifiers: [{ type: "reporter-citation", value: "163 U.S. 537" }],
      },
    },
    {
      noteId: "o9109419-fn1",
      target: {
        status: "identified",
        identifiers: [{ type: "reporter-citation", value: "347 U.S. 483" }],
      },
    },
  ]);
});

test("real 4809723 table and preceding paragraph share note five's scope", () => {
  const html = readFileSync(
    new URL(
      "./__fixtures__/html/html-with-citations-4809723.html",
      import.meta.url,
    ),
    "utf8",
  );
  const text = compose(html, "4591777");
  expect(
    text.blocks.some((block) =>
      block.plainText.includes("1957); United States v. Bruswitz"),
    ),
  ).toBe(true);
  const table = text.blocks.find(
    (block) =>
      block.type === "table" &&
      block.plainText.includes("Less Amount Retained"),
  );
  expect(table).toMatchObject({
    type: "table",
    note: { label: "5", noteId: "o4591777-fn6" },
  });
  if (table === undefined) throw new TypeError("missing real footnote table");
  const before = text.blocks.at(text.blocks.indexOf(table) - 1);
  const scope = text.citationScopes.find((item) =>
    item.blockIds.includes(table.id),
  );
  expect(scope?.boundaries).toBe("proven");
  expect(scope?.blockIds).toContain(before?.id ?? "");
  expect(
    citations(text).documentAst?.blocks.find((block) => block.id === table.id),
  ).toMatchObject({ note: { label: "5", noteId: "o4591777-fn6" } });
});
