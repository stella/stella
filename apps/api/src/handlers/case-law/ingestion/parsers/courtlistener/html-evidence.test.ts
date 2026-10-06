import { expect, test } from "bun:test";

import { opinionRow } from "@/api/handlers/case-law/ingestion/adapters/courtlistener/test-records";

import { composeCourtListenerText } from "./compose";

const compose = (html: string, headmatter = "") => {
  const result = composeCourtListenerText(
    [
      {
        row: opinionRow({ xml_harvard: "", html_anon_2020: html }),
        type: "020lead",
      },
    ],
    { headmatter },
  );
  if (result.status !== "parsed") {
    throw new TypeError(`expected parsed: ${result.status}`);
  }
  return result;
};
for (const domType of [
  "dissentfromdenial",
  "future-opinion-kind",
  "__proto__",
  "majority",
]) {
  test(`a second opinion wrapper ${domType} cannot expand the principal`, () => {
    const text = compose(
      `<div class="opinion" opiniontype="majority"><p>Certiorari denied.</p></div><div class="opinion" opiniontype="${domType}"><p>${"I would grant the petition because the question is important. ".repeat(12)}</p></div>`,
    );
    expect(text.principal.body).toBe("Certiorari denied.");
    expect(text.blocks.at(-1)).toMatchObject({ role: "unknown" });
    expect(text.citationScopes.at(-1)?.boundaries).toBe("unproven");
    expect(text.opinions[0]?.classConflicts).toBe(1);
    expect(text.opinions[0]?.unknownOpinionTypes).toEqual(
      domType === "majority" ? {} : { [domType]: 1 },
    );
  });
}
test("an unrecognized first opinion wrapper never inherits the row's principal class", () => {
  const text = compose(
    `<div class="opinion" opiniontype="future-opinion-kind"><p>${"Independent reasons. ".repeat(40)}</p></div>`,
  );
  expect(text.principal.body).toBe("");
  expect(text.blocks[0]).toMatchObject({ role: "unknown" });
  expect(text.citationScopes[0]?.boundaries).toBe("unproven");
});
const caption = `<center><b>502 U.S. 959 (1991)</b></center><center><h1>DANIELS v. BORG</h1></center><center>No. 91-5746.</center><center><p><b>Supreme Court of United States.</b></p></center><center>November 12, 1991.</center>`;
test("leading layout captions remain readable outside the principal body", () => {
  const text = compose(
    `<div>${caption}<p>C. A. 9th Cir. Certiorari denied.</p></div>`,
  );
  expect(text.principal.body).toBe("C. A. 9th Cir. Certiorari denied.");
  expect(
    text.blocks
      .slice(0, 5)
      .every(
        (block) => block.type === "paragraph" && block.role === "front-matter",
      ),
  ).toBe(true);
});
test("headmatter paragraphs appear once and remain outside principal and citation scopes", () => {
  const headmatter = `<p>502 U.S. 959 (1991)</p><p>November 12, 1991.</p>`;
  const text = compose(
    `<div>${caption}<p>C. A. 9th Cir. Certiorari denied.</p></div>`,
    headmatter,
  );
  for (const line of ["502 U.S. 959 (1991)", "November 12, 1991."]) {
    const matches = text.blocks.filter((block) => block.plainText === line);
    expect(matches).toHaveLength(1);
    expect(
      text.citationScopes.some((scope) =>
        scope.blockIds.includes(matches[0]?.id ?? ""),
      ),
    ).toBe(false);
  }
  expect(text.principal.body).toBe("C. A. 9th Cir. Certiorari denied.");
});
test("embedded HTML preformatted text keeps its line breaks", () => {
  const text = compose(
    `<div><p>Note follows.</p><pre>FIRST line\n    indented line\n\nSECOND paragraph</pre></div>`,
  );
  expect(text.blocks.at(-1)?.plainText).toBe(
    "FIRST line\n indented line\n\nSECOND paragraph",
  );
  expect(text.blocks.at(-1)).toMatchObject({
    inlines: [
      { type: "text", text: "FIRST line" },
      { type: "line-break" },
      { type: "text", text: "    indented line" },
      { type: "line-break" },
      { type: "line-break" },
      { type: "text", text: "SECOND paragraph" },
    ],
  });
});

test("reports a resumed principal run after a nested opinion without merging scopes", () => {
  const text = compose(
    `<div class="opinion" opiniontype="majority"><p>410 U.S. 113.</p><div class="opinion" opiniontype="dissent"><p>I dissent.</p></div><p>Id. at 120.</p></div>`,
  );
  expect(text.opinions[0]?.resumedPrincipalRuns).toBe(1);
  expect(text.citationScopes).toHaveLength(3);
});
