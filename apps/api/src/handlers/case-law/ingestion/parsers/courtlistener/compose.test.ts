import { describe, expect, test } from "bun:test";

import { type DocumentAst, isDocumentAst } from "@stll/legal-ast/document-ast";

import type { Block } from "@/api/handlers/case-law/document-ast";
import { classifyCourtListenerDecision } from "@/api/handlers/case-law/ingestion/adapters/courtlistener/order-classification";
import type { OpinionRow } from "@/api/handlers/case-law/ingestion/adapters/courtlistener/snapshot-columns";
import {
  opinionRow,
  recordedClusters,
} from "@/api/handlers/case-law/ingestion/adapters/courtlistener/test-records";
import { isOpinionType } from "@/api/handlers/case-law/ingestion/adapters/courtlistener/vocabulary";
import { extractDecisionCitations } from "@/api/handlers/case-law/ingestion/citation-extractor";
import { indexCitationScopes } from "@/api/handlers/case-law/ingestion/citation-scopes";

import {
  composeCourtListenerText,
  type CourtListenerTextOpinion,
  type CourtListenerTextOutcome,
} from "./compose";
import { COURTLISTENER_TEXT_LIMITS, createTextBudget } from "./outcome";
import {
  COURTLISTENER_TEXT_FORMATS,
  selectOpinionText,
  textStructureOf,
} from "./select";
import {
  parsedWords,
  recordedOpinionClusters,
  sourceWords,
  wordDifference,
} from "./test-oracle";

const fixture = (clusterId: string): CourtListenerTextOpinion[] => {
  const opinions = recordedOpinionClusters().get(clusterId);
  if (opinions === undefined) {
    throw new Error(`no fixture for cluster ${clusterId}`);
  }
  return opinions;
};

/** The one opinion of a single-row fixture, with some columns replaced. */
const mutated = (
  clusterId: string,
  columns: Partial<Record<keyof OpinionRow, string>>,
): CourtListenerTextOpinion[] =>
  fixture(clusterId).map(({ row, type }) => ({
    row: { ...row, ...columns },
    type,
  }));

const parsed = (outcome: CourtListenerTextOutcome) => {
  if (outcome.status !== "parsed") {
    throw new Error(`expected a parsed cluster, got ${outcome.status}`);
  }
  return outcome;
};

const asDocument = (blocks: readonly Block[]): DocumentAst => ({
  version: 1,
  source: {
    system: "courtlistener",
    documentId: "",
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
  blocks: [...blocks],
});

const RECORDED = [
  "380339",
  "2099017",
  "5094940",
  "5804213",
  "10637146",
  "10742675",
] as const;

describe("which column becomes an opinion's text", () => {
  // Each supported structure is reached first as the winner and then as the
  // fallback, by a synthetic mutation that makes the column above it unusable.
  const matrix = [
    {
      name: "Harvard XML wins",
      cluster: "5804213",
      columns: {},
      winner: "xml_harvard/xml",
      refused: [],
    },
    {
      name: "the citation column's XML stands in for malformed Harvard XML",
      cluster: "5804213",
      columns: { xml_harvard: '<opinion type="majority"><p>Truncated' },
      winner: "html_with_citations/xml",
      refused: ["xml_harvard/xml:malformed-xml"],
    },
    {
      name: "the citation column's XML stands in for script-only Harvard XML",
      cluster: "380339",
      columns: { xml_harvard: "<opinion><script>x()</script></opinion>" },
      winner: "html_with_citations/xml",
      refused: ["xml_harvard/xml:no-visible-text"],
    },
    {
      name: "the citation column's XML stands in for Harvard XML carrying markup as text",
      cluster: "5804213",
      columns: {
        xml_harvard:
          '<opinion type="majority"><p>&lt;p class="x"&gt;The judgment is affirmed.&lt;/p&gt;</p></opinion>',
      },
      winner: "html_with_citations/xml",
      refused: ["xml_harvard/xml:markup-residue"],
    },
    {
      name: "a preformatted citation column wins over plain text",
      cluster: "5094940",
      columns: {},
      winner: "html_with_citations/pre",
      refused: ["xml_harvard/xml:blank"],
    },
    {
      name: "plain text stands in for an empty preformatted body",
      cluster: "5094940",
      columns: { html_with_citations: '<pre class="inline">\n</pre>' },
      winner: "plain_text/plain",
      refused: [
        "xml_harvard/xml:blank",
        "html_with_citations/pre:no-visible-text",
        "html_lawbox/html:blank",
        "html_columbia/html:blank",
        "html_anon_2020/html:blank",
        "html/html:blank",
      ],
    },
    {
      name: "plain text wins where it is all there is",
      cluster: "10742675",
      columns: {},
      winner: "plain_text/plain",
      refused: [
        "xml_harvard/xml:blank",
        "html_with_citations/html:blank",
        "html_lawbox/html:blank",
        "html_columbia/html:blank",
        "html_anon_2020/html:blank",
        "html/html:blank",
      ],
    },
  ] as const;

  for (const { cluster, columns, name, refused, winner } of matrix) {
    test(name, () => {
      const outcome = parsed(
        composeCourtListenerText(mutated(cluster, columns)),
      );
      const [report] = outcome.opinions;
      if (report === undefined) {
        throw new Error("expected an opinion report");
      }
      expect(`${report.format ?? "none"}/${report.structure ?? "none"}`).toBe(
        winner,
      );
      expect(
        report.attempts.map(
          ({ format, reason, structure }) => `${format}/${structure}:${reason}`,
        ),
      ).toEqual([...refused]);
    });
  }

  test("stops at a structure no parser reads yet rather than fall to plain text", () => {
    const outcome = composeCourtListenerText(
      mutated("5094940", { html_with_citations: "<div><p>Opinion.</p></div>" }),
    );
    expect(outcome.status).toBe("unsupported");
    expect(outcome.opinions[0]).toMatchObject({
      selection: "unsupported",
      format: "html_with_citations",
    });
  });

  test("holds the cluster when no column is usable", () => {
    const blank = Object.fromEntries(
      COURTLISTENER_TEXT_FORMATS.map((format) => [format, ""]),
    );
    const outcome = composeCourtListenerText(mutated("10742675", blank));
    expect(outcome).toMatchObject({ status: "held", reason: "no-usable-text" });
    expect(outcome.opinions[0]?.attempts).toHaveLength(
      COURTLISTENER_TEXT_FORMATS.length,
    );
  });

  test("needs the page images where only scan layout is left", () => {
    const blank = Object.fromEntries(
      COURTLISTENER_TEXT_FORMATS.map((format) => [format, ""]),
    );
    const outcome = composeCourtListenerText(
      mutated("10742675", {
        ...blank,
        xml_scan: "<page><word>Affirmed</word></page>",
      }),
    );
    expect(outcome).toMatchObject({
      status: "held",
      reason: "requires-assets",
    });
    expect(outcome.opinions[0]).toMatchObject({ format: "xml_scan" });
  });

  test("holds a body image instead of publishing the text around it", () => {
    const outcome = composeCourtListenerText(
      mutated("5804213", {
        xml_harvard:
          '<opinion type="majority"><p>As shown:</p><img src="https://x.test/f.png"/></opinion>',
      }),
    );
    expect(outcome).toMatchObject({
      status: "held",
      reason: "requires-assets",
    });
  });

  test("one opinion without text holds the others with it", () => {
    const lead = fixture("5804213");
    const blankDissent = {
      row: opinionRow({ id: "1", type: "040dissent", xml_harvard: "" }),
      type: "040dissent" as const,
    };
    expect(composeCourtListenerText([...lead, blankDissent])).toMatchObject({
      status: "held",
      reason: "no-usable-text",
    });
  });
});

describe("the named text limits", () => {
  test("holds a cluster whose markup passes the DOM node limit, untruncated", () => {
    const paragraphs = "<p>x</p>".repeat(
      COURTLISTENER_TEXT_LIMITS.DOM_NODES / 2 + 1,
    );
    const outcome = composeCourtListenerText([
      {
        row: opinionRow({
          id: "1",
          xml_harvard: `<opinion>${paragraphs}</opinion>`,
        }),
        type: "020lead",
      },
    ]);
    expect(outcome).toMatchObject({ status: "held", reason: "over-limit" });
  });

  test("holds markup nested past the depth limit instead of exhausting the stack", () => {
    const depth = 50_000;
    const nested = `${"<span>".repeat(depth)}x${"</span>".repeat(depth)}`;
    for (const columns of [
      { xml_harvard: `<opinion><p>${nested}</p></opinion>` },
      { xml_harvard: "", html_with_citations: `<pre>${nested}</pre>` },
    ]) {
      const outcome = composeCourtListenerText([
        { row: opinionRow({ id: "1", ...columns }), type: "020lead" },
      ]);
      expect(outcome).toMatchObject({ status: "held", reason: "over-limit" });
    }
  });

  test("holds a cluster that would emit more blocks than the limit", () => {
    const text = Array.from(
      { length: COURTLISTENER_TEXT_LIMITS.BLOCKS + 1 },
      (_, index) => `Paragraph ${index}.`,
    ).join("\n\n\n");
    const outcome = composeCourtListenerText([
      {
        row: opinionRow({ id: "1", xml_harvard: "", plain_text: text }),
        type: "020lead",
      },
    ]);
    expect(outcome).toMatchObject({ status: "held", reason: "over-limit" });
  });
});

describe("recorded opinions", () => {
  // Word multisets from an oracle that shares no code with the parsers: no
  // word lost, none repeated, for every column any structure here reads.
  test("every supported column conserves its words", () => {
    let checked = 0;
    for (const clusterId of RECORDED) {
      for (const { row, type } of fixture(clusterId)) {
        for (const format of COURTLISTENER_TEXT_FORMATS) {
          const source = row[format];
          const structure = textStructureOf(format, source);
          if (source.trim() === "" || structure === "html") {
            continue;
          }
          const alone = {
            ...row,
            ...Object.fromEntries(
              COURTLISTENER_TEXT_FORMATS.map((other) => [
                other,
                other === format ? source : "",
              ]),
            ),
          };
          const selection = selectOpinionText({
            row: alone,
            type,
            budget: createTextBudget(),
          });
          expect(selection.status).toBe("parsed");
          if (selection.status !== "parsed") {
            continue;
          }
          const blocks = selection.text.units.flatMap(
            ({ blocks: unit }) => unit,
          );
          expect({
            format,
            ...wordDifference(
              sourceWords(structure, source),
              parsedWords(blocks),
            ),
          }).toEqual({
            format,
            missing: [],
            extra: [],
          });
          checked += 1;
        }
      }
    }
    // Harvard XML twice (its own column and the citation column's copy) for
    // three opinions, two preformatted bodies and three plain texts.
    expect(checked).toBe(11);
  });

  test("scope every opinion block exactly once and form a valid document", () => {
    for (const clusterId of RECORDED) {
      const { blocks, citationScopes } = parsed(
        composeCourtListenerText(fixture(clusterId)),
      );
      expect(indexCitationScopes(blocks, citationScopes).isOk()).toBe(true);
      const scoped = citationScopes.flatMap(({ blockIds }) => blockIds);
      expect(scoped.toSorted()).toEqual(blocks.map(({ id }) => id).toSorted());
      expect(new Set(blocks.map(({ id }) => id)).size).toBe(blocks.length);
      expect(new Set(blocks.map(({ anchorId }) => anchorId)).size).toBe(
        blocks.length,
      );
      expect(isDocumentAst(asDocument(blocks))).toBe(true);
    }
  });

  test("the same rows in any order compose the same document", () => {
    for (const clusterId of RECORDED) {
      const opinions = fixture(clusterId);
      expect(composeCourtListenerText(opinions.toReversed())).toEqual(
        composeCourtListenerText(opinions),
      );
      expect(composeCourtListenerText(opinions)).toEqual(
        composeCourtListenerText(opinions),
      );
    }
  });
});

describe("principal text for the order classifier", () => {
  const recordedOpinions = (clusterId: string): CourtListenerTextOpinion[] => {
    const record = recordedClusters().find(
      ({ cluster }) => cluster.id === clusterId,
    );
    if (record === undefined) {
      throw new Error(`no recorded cluster ${clusterId}`);
    }
    return record.opinions.map((row) => {
      if (!isOpinionType(row.type)) {
        throw new Error("undeclared type");
      }
      return { row, type: row.type };
    });
  };

  const classify = (
    opinions: readonly CourtListenerTextOpinion[],
    scdbPresent = false,
  ) => {
    const outcome = parsed(composeCourtListenerText(opinions));
    return {
      outcome,
      classification: classifyCourtListenerDecision({
        opinionTypes: opinions.map(({ type }) => type),
        scdbPresent,
        principal: outcome.principal,
      }),
    };
  };

  // Cluster 9114988 (recorded with the record contract): a Supreme Court
  // certiorari denial for three petitions, with Justice White's dissent.
  test("reads a certiorari denial as an order despite its dissent", () => {
    const { classification, outcome } = classify(recordedOpinions("9114988"));
    expect(outcome.citationScopes.map(({ opinionId }) => opinionId)).toEqual([
      "cl-opinion:9109495",
      "cl-opinion:9109497",
    ]);
    expect(outcome.principal.body).toBe(
      [
        "C. A. 8th Cir.;",
        "C. A. 7th Cir.; and",
        "C. A. 5th Cir. Certiorari denied. Reported below: No. 90-1628, 920 F. 2d 498; No. 91-5013, 925 F. 2d 1064; No. 91-5087, 931 F. 2d 890.",
      ].join("\n"),
    );
    expect(classification).toMatchObject({
      kind: "order",
      rule: "short-order-wording",
    });
    const dissent = outcome.blocks.filter(({ id }) =>
      id.startsWith("o9109497-"),
    );
    expect(dissent[0]).toMatchObject({
      type: "heading",
      plainText: "Justice White,",
    });
    expect(
      dissent
        .slice(1)
        .every(
          (block) => block.type === "paragraph" && block.role === "dissent",
        ),
    ).toBe(true);
    // "investí-*963gate": the page break falls inside the word.
    expect(
      dissent.some(({ plainText }) =>
        plainText.includes("investí-gate other crimes"),
      ),
    ).toBe(true);
  });

  test("reads a majority opinion's structure as an opinion", () => {
    const { classification, outcome } = classify(fixture("5804213"));
    expect(outcome.principal).toMatchObject({
      structuralOpinion: true,
      singleOpinionBody: true,
    });
    expect(classification).toMatchObject({
      kind: "opinion",
      rule: "structural-opinion",
    });
  });

  test("proves no single opinion in a combined row without structure", () => {
    const { classification, outcome } = classify(fixture("5094940"));
    expect(outcome.principal).toMatchObject({
      structuralOpinion: false,
      singleOpinionBody: false,
    });
    expect(classification.kind).toBe("unclassified");
  });

  // Cluster 10742675: a district court's "OPINION AND ORDER" in plain text.
  test("proves no opinion body from one trial court row of layout text", () => {
    const { classification, outcome } = classify(fixture("10742675"));
    expect(outcome.principal).toMatchObject({
      orderHeading: false,
      structuralOpinion: false,
      singleOpinionBody: false,
    });
    expect(classification).toMatchObject({
      kind: "unclassified",
      rule: "long-body-without-corroboration",
    });
  });

  // Cluster 10637146: a long trial court order whose caption names it an
  // ORDER in a caption column, not as a title of its own; it stays
  // unclassified rather than become an opinion or an order on layout.
  test("leaves a long trial order titled only in its caption unclassified", () => {
    const { classification, outcome } = classify(fixture("10637146"));
    expect(outcome.principal).toMatchObject({
      orderHeading: false,
      singleOpinionBody: false,
    });
    expect(classification.kind).toBe("unclassified");
  });

  // Cluster 2099017: a per curiam order whose markup opens with an ORDER
  // title before its author line.
  test("reads a root ORDER title as order evidence and keeps it out of the body", () => {
    const { classification, outcome } = classify(fixture("2099017"));
    expect(outcome.principal.orderHeading).toBe(true);
    expect(outcome.principal.body).toStartWith(
      "AND NOW, this 23rd day of June, 2010",
    );
    expect(classification).toMatchObject({
      kind: "order",
      rule: "order-heading",
    });
  });

  test("does not read an ORDER heading later in an opinion as a root title", () => {
    const text = "The claims fail for the reasons given. ".repeat(20);
    const { classification, outcome } = classify([
      {
        row: opinionRow({
          id: "1",
          xml_harvard: `<opinion type="majority"><p>${text}</p><p>ORDER</p><p>The motion is denied.</p></opinion>`,
        }),
        type: "020lead",
      },
    ]);
    expect(outcome.principal.orderHeading).toBe(false);
    expect(classification.kind).toBe("opinion");
  });

  // Synthetic rows: the row types that prove no class need markup to prove
  // an opinion; a long body alone leaves them unclassified.
  const unproven = "The report is adopted and the action is dismissed. ".repeat(
    15,
  );
  const provenCases = [
    [
      "a long trial order in plain text",
      "100trialcourt",
      { xml_harvard: "", plain_text: unproven },
      "unclassified",
    ],
    [
      "an addendum",
      "050addendum",
      { xml_harvard: `<opinion><p>${unproven}</p></opinion>` },
      "unclassified",
    ],
    [
      "a trial opinion its markup calls a majority opinion",
      "100trialcourt",
      { xml_harvard: `<opinion type="majority"><p>${unproven}</p></opinion>` },
      "opinion",
    ],
  ] as const;

  for (const [name, type, columns, kind] of provenCases) {
    test(`classifies ${name} as ${kind}`, () => {
      const { classification } = classify([
        { row: opinionRow({ id: "1", type, ...columns }), type },
      ]);
      expect(classification.kind).toBe(kind);
    });
  }

  test("keeps a unit whose row and markup disagree out of the principal text", () => {
    const { outcome } = classify([
      {
        row: opinionRow({
          id: "1",
          type: "040dissent",
          xml_harvard:
            '<opinion type="majority"><p>The judgment is affirmed.</p></opinion>',
        }),
        type: "040dissent",
      },
    ]);
    expect(outcome.opinions[0]?.classConflicts).toBe(1);
    expect(outcome.principal.body).toBe("");
    expect(outcome.blocks[0]).toMatchObject({ role: "unknown" });
  });

  test("keeps a nested dissent out of the principal text", () => {
    const dissent =
      "I would grant the petition for reasons discussed here. ".repeat(15);
    const { classification, outcome } = classify([
      {
        row: opinionRow({
          id: "1",
          xml_harvard: `<opinion type="majority"><p>Certiorari denied.</p><opinion type="dissent"><author>Justice White, dissenting.</author><p>${dissent}</p></opinion></opinion>`,
        }),
        type: "020lead",
      },
    ]);
    expect(outcome.principal.body).toBe("Certiorari denied.");
    expect(classification).toMatchObject({
      kind: "order",
      rule: "short-order-wording",
    });
    expect(outcome.blocks.at(-1)).toMatchObject({ role: "dissent" });
    expect(outcome.citationScopes.map(({ opinionId }) => opinionId)).toEqual([
      "cl-opinion:1",
      "cl-opinion:1/2",
    ]);
  });

  test("keeps a nested concurrence and a conflicting unit out of the principal text", () => {
    const concurrence =
      "I join the opinion of the Court and write to add a point. ".repeat(12);
    const { outcome } = classify([
      {
        row: opinionRow({
          id: "1",
          xml_harvard: `<casebody><opinion type="majority"><p>The judgment is affirmed.</p><opinion type="concurrence"><p>${concurrence}</p></opinion></opinion><opinion type="dissent"><p>I dissent.</p></opinion></casebody>`,
        }),
        type: "020lead",
      },
    ]);
    expect(outcome.principal.body).toBe("The judgment is affirmed.");
    expect(outcome.opinions[0]?.classConflicts).toBe(1);
    const roles = outcome.blocks.map((block) =>
      block.type === "paragraph" ? block.role : null,
    );
    expect(roles).toEqual(["argumentation", "argumentation", "unknown"]);
  });
});

describe("short forms across unproven note boundaries", () => {
  const idTarget = (outcome: CourtListenerTextOutcome) => {
    const { blocks, citationScopes } = parsed(outcome);
    const extracted = extractDecisionCitations({
      country: "USA",
      documentAst: asDocument(blocks),
      citationScopes,
      sections: [],
    });
    if (extracted.isErr()) {
      throw new Error(`extraction rejected: ${extracted.error.message}`);
    }
    const { citations, occurrences } = extracted.value;
    return {
      full: citations.map(({ identifierValue }) => identifierValue),
      id: occurrences
        .filter(({ form }) => form === "id")
        .map(({ target }) => target),
    };
  };

  // One opinion, three renderings. Its markup says the middle paragraph is a
  // note, so the body's Id. skips it; layout says nothing of the kind, so the
  // same Id. must not resolve through the note's citation.
  const holding = "The holding follows 410 U.S. 113.";
  const exception = "The exception follows 347 U.S. 483.";
  const pin = "Id. at 120 controls the holding.";

  test("markup that marks the note resolves the body's Id. past it", () => {
    const { full, id } = idTarget(
      composeCourtListenerText([
        {
          row: opinionRow({
            id: "1",
            xml_harvard: `<opinion type="majority"><p>${holding}</p><footnote label="1"><p>${exception}</p></footnote><p>${pin}</p></opinion>`,
          }),
          type: "020lead",
        },
      ]),
    );
    expect(full).toEqual(["410 U.S. 113", "347 U.S. 483"]);
    expect(id).toEqual([
      {
        status: "identified",
        identifiers: [{ type: "reporter-citation", value: "410 U.S. 113" }],
      },
    ]);
  });

  for (const [name, columns] of [
    [
      "plain text",
      {
        xml_harvard: "",
        plain_text: `${holding}\n\n1. ${exception}\n\n${pin}`,
      },
    ],
    [
      "a preformatted body",
      {
        xml_harvard: "",
        html_with_citations: `<pre class="inline">${holding}\n\n1. ${exception}\n\n${pin}</pre>`,
      },
    ],
    [
      "layout text running the note into the next page",
      { xml_harvard: "", plain_text: `${holding}\n1. ${exception}\f${pin}` },
    ],
  ] as const) {
    test(`${name} keeps every full citation and resolves no Id. through the note`, () => {
      const { full, id } = idTarget(
        composeCourtListenerText([
          { row: opinionRow({ id: "1", ...columns }), type: "020lead" },
        ]),
      );
      expect(full).toEqual(["410 U.S. 113", "347 U.S. 483"]);
      expect(id).toHaveLength(1);
      expect(id[0]?.status).toBe("unresolved");
    });
  }
});
