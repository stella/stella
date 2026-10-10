import { Result } from "better-result";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { opinionRow } from "@/api/handlers/case-law/ingestion/adapters/courtlistener/test-records";
import type { OpinionType } from "@/api/handlers/case-law/ingestion/adapters/courtlistener/vocabulary";
import { extractDecisionCitations } from "@/api/handlers/case-law/ingestion/citation-extractor";

import { composeCourtListenerText } from "./compose";
import type { CourtListenerHtmlFormat } from "./html";

// Labels below were read from the five complete publisher fields, independently
// of the parser and retention oracle. Added Id. probes are labelled mutations.
const FIXTURES = {
  citations: {
    file: "html-with-citations-379615",
    id: "379615",
    format: "html_with_citations",
    type: "010combined",
  },
  lawbox: {
    file: "html-lawbox-2099017",
    id: "2099017",
    format: "html_lawbox",
    type: "010combined",
  },
  columbia: {
    file: "html-columbia-3262966",
    id: "3265222",
    format: "html_columbia",
    type: "020lead",
  },
  anon: {
    file: "html-anon-2020-4812730",
    id: "4597895",
    format: "html_anon_2020",
    type: "010combined",
  },
  generic: {
    file: "html-383875",
    id: "383875",
    format: "html",
    type: "010combined",
  },
} as const satisfies Record<
  string,
  {
    file: string;
    id: string;
    format: CourtListenerHtmlFormat;
    type: OpinionType;
  }
>;

type Fixture = (typeof FIXTURES)[keyof typeof FIXTURES];
const source = ({ file }: Fixture) =>
  readFileSync(
    new URL(`__fixtures__/html/${file}.html`, import.meta.url),
    "utf-8",
  );
const compose = (fixture: Fixture, html = source(fixture)) => {
  const result = composeCourtListenerText([
    {
      type: fixture.type,
      row: opinionRow({
        id: fixture.id,
        type: fixture.type,
        xml_harvard: "",
        [fixture.format]: html,
      }),
    },
  ]);
  if (result.status !== "parsed") {
    throw new TypeError(`Expected parsed ${fixture.file}: ${result.status}`);
  }
  return result;
};
type Composed = ReturnType<typeof compose>;
const blockWith = (text: Composed, phrase: string) => {
  const matches = text.blocks.filter(({ plainText }) =>
    plainText.includes(phrase),
  );
  expect(matches.length, `unique publisher span: ${phrase}`).toBe(1);
  const block = matches.at(0);
  if (block === undefined) {
    throw new TypeError(`Missing publisher span: ${phrase}`);
  }
  return block;
};
const scopeOf = (text: Composed, phrase: string) => {
  const { id } = blockWith(text, phrase);
  return text.citationScopes.find(({ blockIds }) => blockIds.includes(id));
};
const extract = (text: Composed) => {
  const result = extractDecisionCitations({
    country: "USA",
    sections: text.sections,
    citationScopes: text.citationScopes,
    documentAst: {
      version: 1,
      source: {
        system: "courtlistener",
        documentId: "real-html-fixture",
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
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
};
const replaceOnce = (html: string, original: string, replacement: string) => {
  expect(html.split(original).length).toBe(2);
  return html.replace(original, () => replacement);
};

for (const fixture of [FIXTURES.citations, FIXTURES.lawbox, FIXTURES.generic]) {
  test(`real ${fixture.format} preserves full citations while all declared layout scopes remain unproven`, () => {
    const text = compose(fixture);
    expect(text.citationScopes.length).toBeGreaterThan(0);
    expect(
      text.citationScopes.every(({ boundaries }) => boundaries === "unproven"),
    ).toBe(true);
    let citation = "634 F.2d 404";
    if (fixture === FIXTURES.citations) {
      citation = "624 F.2d 1090";
    } else if (fixture === FIXTURES.lawbox) {
      citation = "996 A.2d 488";
    }
    const block = blockWith(text, citation);
    const found = extract(text).occurrences.filter(
      ({ blockId, target }) =>
        blockId === block.id && target.status === "identified",
    );
    expect(found.length).toBeGreaterThan(0);
    expect(
      found.some(
        ({ target }) =>
          target.status === "identified" &&
          target.identifiers.some(({ value }) => value === citation),
      ),
    ).toBe(true);
  });
}

test("real citation HTML keeps the caption and two disposition lines in publisher order", () => {
  const text = compose(FIXTURES.citations);
  expect(text.blocks.map(({ plainText }) => plainText)).toEqual([
    "624 F.2d 1090",
    "Lenhardt\nv.\nRichards",
    "79-2764",
    "UNITED STATES COURT OF APPEALS Third Circuit",
    "6/3/80",
    "D.Virgin Islands",
    "AFFIRMED",
  ]);
  for (const phrase of [
    "624 F.2d 1090",
    "Lenhardt",
    "79-2764",
    "UNITED STATES COURT OF APPEALS Third Circuit",
    "6/3/80",
  ]) {
    expect(blockWith(text, phrase)).toMatchObject({
      type: "paragraph",
      role: "front-matter",
    });
    expect(text.principal.body).not.toContain(phrase);
  }
  expect(scopeOf(text, "AFFIRMED")?.boundaries).toBe("unproven");
  expect(text.principal.body).toContain("D.Virgin Islands\nAFFIRMED");
});

test("real Lawbox separates its centered caption from the root order", () => {
  const text = compose(FIXTURES.lawbox);
  for (const phrase of [
    "996 A.2d 488 (2010)",
    "Frederick EVANS",
    "No. 31 EAP 2009",
    "Supreme Court of Pennsylvania.",
    "June 23, 2010.",
  ]) {
    expect(blockWith(text, phrase)).toMatchObject({
      type: "paragraph",
      role: "front-matter",
    });
    expect(text.principal.body).not.toContain(phrase);
  }
  expect(blockWith(text, "ORDER")).toMatchObject({ type: "heading" });
  expect(text.principal.body).toBe(
    "PER CURIAM.\nAND NOW, this 23rd day of June, 2010, Appellees' Motion to Strike/Preclude Certain Items Listed in Designation of Contents of Reproduced Record is GRANTED, and the order of the Commonwealth Court dated June 12, 2009, in the above matter, is AFFIRMED.",
  );
  expect(scopeOf(text, "AND NOW")?.boundaries).toBe("unproven");
});

test("real Columbia separates its one marked note from the approval and quoted statute", () => {
  const text = compose(FIXTURES.columbia);
  const note = blockWith(
    text,
    'It is my opinion that the parties to the proposed agreement are included within the definition of "public agencies"',
  );
  expect(note).toMatchObject({
    type: "paragraph",
    note: { type: "footnote", label: "1" },
  });
  expect(note.plainText).toContain(
    "2002-345 (discussing what types of entities qualify",
  );
  expect(
    blockWith(
      text,
      "It is the purpose of this chapter to permit local governmental units",
    ),
  ).toMatchObject({ type: "paragraph", role: "quote" });
  expect(text.principal.body).toContain("It is therefore hereby approved.");
  expect(text.principal.body).toContain("MIKE BEEBE Attorney General");
  expect(text.principal.body).not.toContain(note.plainText);
  expect(scopeOf(text, "It is therefore hereby approved.")).toMatchObject({
    opinionId: "cl-opinion:3265222",
    boundaries: "proven",
  });
  expect(scopeOf(text, "It is the purpose of this chapter")).toEqual(
    scopeOf(text, "It is therefore hereby approved."),
  );
  expect(scopeOf(text, "It is my opinion that the parties")).toEqual(
    scopeOf(text, "It is therefore hereby approved."),
  );
  expect(
    text.blocks.filter(
      (block) => block.type === "paragraph" && block.note !== undefined,
    ),
  ).toEqual([note]);
});

test("real anonymous HTML keeps majority, caption, counsel and detached note separate", () => {
  const text = compose(FIXTURES.anon);
  expect(blockWith(text, "HERBERT and PATRICIA KEMPKER")).toMatchObject({
    type: "paragraph",
    role: "parties",
  });
  expect(blockWith(text, "Michael C. Cohen,")).toMatchObject({
    type: "paragraph",
    role: "counsel",
  });
  expect(scopeOf(text, "HERBERT and PATRICIA KEMPKER")).toBeUndefined();
  expect(scopeOf(text, "Michael C. Cohen,")).toBeUndefined();
  const note = blockWith(
    text,
    "We note that neither petitioners nor their counsel appeared",
  );
  expect(note).toMatchObject({
    type: "paragraph",
    note: { type: "footnote", label: "1" },
  });
  const majority = scopeOf(text, "82 T.C. 96");
  expect(majority).toMatchObject({
    opinionId: "cl-opinion:4597895",
    boundaries: "proven",
  });
  expect(
    scopeOf(text, "An appropriate order and decision will be entered."),
  ).toEqual(majority);
  expect(scopeOf(text, "We note that neither petitioners")).toMatchObject({
    opinionId: "cl-opinion:4597895/note-1",
    boundaries: "proven",
  });
  expect(text.principal.body).toContain(
    "Respondent determined a deficiency of $37,210",
  );
  expect(text.principal.body).toContain(
    "An appropriate order and decision will be entered.",
  );
  expect(text.principal.body).not.toContain(note.plainText);
  expect(text.principal.body).not.toContain("Michael C. Cohen");
});

test("real generic HTML keeps the quoted lower-court citation and the judge note in different unproven scopes", () => {
  const text = compose(FIXTURES.generic);
  for (const phrase of [
    "634 F.2d 404",
    "6 Bankr.Ct.Dec. 1361",
    "OCCIDENTAL PETROLEUM CORPORATION",
    "No. 80-1050.",
    "United States Court of Appeals",
    "Submitted Nov. 10, 1980.",
  ]) {
    expect(blockWith(text, phrase)).toMatchObject({
      type: "paragraph",
      role: "front-matter",
    });
    expect(text.principal.body).not.toContain(phrase);
  }
  expect(blockWith(text, "1 B.R. 522").plainText).toBe(
    "1 B.R. 522, 525-26 (D.C.W.D.Mo.1979) (footnote omitted).",
  );
  const note = blockWith(text, "The Honorable Elmo B. Hunter");
  expect(note).toMatchObject({
    type: "paragraph",
    note: { type: "footnote", label: "1" },
  });
  expect(note.plainText).toBe(
    "The Honorable Elmo B. Hunter, United States District Judge for the Western District of Missouri",
  );
  expect(scopeOf(text, "The Honorable Elmo B. Hunter")?.opinionId).not.toBe(
    scopeOf(text, "1 B.R. 522")?.opinionId,
  );
  expect(text.principal.body).not.toContain(note.plainText);
  expect(text.principal.body).toContain(
    "We therefore affirm on the basis of Judge Hunter's opinion.",
  );
});

for (const fixture of [FIXTURES.citations, FIXTURES.lawbox, FIXTURES.generic]) {
  test(`synthetic Id probe in real ${fixture.format} cannot acquire a layout antecedent`, () => {
    const html = `${source(fixture)}<p>See 410 U.S. 113. Id. at 120.</p>`;
    const text = compose(fixture, html);
    const probe = blockWith(text, "See 410 U.S. 113. Id. at 120.");
    const occurrences = extract(text).occurrences.filter(
      ({ blockId }) => blockId === probe.id,
    );
    expect(occurrences.filter(({ form }) => form === "full")).toMatchObject([
      { target: { status: "identified" } },
    ]);
    expect(occurrences.filter(({ form }) => form === "id")).toMatchObject([
      { target: { status: "unresolved", reason: "scope-unknown" } },
    ]);
  });
}

test("synthetic Id probes on real anonymous body and detached note cannot share antecedents", () => {
  let html = replaceOnce(
    source(FIXTURES.anon),
    "<p>To reflect the foregoing, </p>",
    "<p>To reflect the foregoing, see 410 U.S. 113. Id. at 120.</p>",
  );
  html = replaceOnce(
    html,
    "entry of decision.<a",
    "entry of decision. Id. at 121.<a",
  );
  const text = compose(FIXTURES.anon, html);
  const body = blockWith(
    text,
    "To reflect the foregoing, see 410 U.S. 113. Id. at 120.",
  );
  const note = blockWith(text, "We note that neither petitioners");
  const ids = extract(text).occurrences.filter(({ form }) => form === "id");
  expect(ids.length).toBe(2);
  expect(ids.find(({ blockId }) => blockId === body.id)).toMatchObject({
    opinionId: "cl-opinion:4597895",
    noteId: null,
    target: {
      status: "identified",
      identifiers: [{ type: "reporter-citation", value: "410 U.S. 113" }],
    },
  });
  const noteId = note.type === "paragraph" ? note.note?.noteId : undefined;
  expect(noteId).toBeDefined();
  expect(ids.find(({ blockId }) => blockId === note.id)).toMatchObject({
    opinionId: "cl-opinion:4597895/note-1",
    noteId,
    target: { status: "unresolved", reason: "missing-antecedent" },
  });
});

test("synthetic Id probes on real Columbia body and embedded note cannot share antecedents", () => {
  let html = replaceOnce(
    source(FIXTURES.columbia),
    "<p>MB:EAW/cyh</p>",
    "<p>MB:EAW/cyh</p><p>See 410 U.S. 113. Id. at 120.</p>",
  );
  html = replaceOnce(
    html,
    "</a></sup> It is my opinion",
    "</a></sup> Id. at 121. It is my opinion",
  );
  const text = compose(FIXTURES.columbia, html);
  const body = blockWith(text, "See 410 U.S. 113. Id. at 120.");
  const note = blockWith(text, "Id. at 121. It is my opinion");
  const ids = extract(text).occurrences.filter(({ form }) => form === "id");
  expect(ids.length).toBe(2);
  expect(ids.find(({ blockId }) => blockId === body.id)).toMatchObject({
    opinionId: "cl-opinion:3265222",
    noteId: null,
    target: {
      status: "identified",
      identifiers: [{ type: "reporter-citation", value: "410 U.S. 113" }],
    },
  });
  const noteId = note.type === "paragraph" ? note.note?.noteId : undefined;
  expect(noteId).toBeDefined();
  expect(ids.find(({ blockId }) => blockId === note.id)).toMatchObject({
    opinionId: "cl-opinion:3265222",
    noteId,
    target: { status: "unresolved", reason: "missing-antecedent" },
  });
});

test("synthetic caption citation on real Columbia cannot become a body antecedent", () => {
  const html = `<p class="case_cite">410 U.S. 113</p><p>Id. at 120.</p>${source(FIXTURES.columbia)}`;
  const text = compose(FIXTURES.columbia, html);
  expect(blockWith(text, "410 U.S. 113")).toMatchObject({
    type: "paragraph",
    role: "front-matter",
  });
  const occurrences = extract(text).occurrences;
  expect(occurrences.filter(({ form }) => form === "full")).toMatchObject([
    {
      target: {
        status: "identified",
        identifiers: [{ type: "reporter-citation", value: "410 U.S. 113" }],
      },
    },
  ]);
  expect(occurrences.filter(({ form }) => form === "id")).toMatchObject([
    { target: { status: "unresolved" } },
  ]);
});
