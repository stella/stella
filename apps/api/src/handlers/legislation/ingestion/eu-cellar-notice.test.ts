import { panic } from "better-result";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { parseEuCellarMetadata } from "./eu-cellar-metadata";
import { parseEuCellarNotice } from "./eu-cellar-notice";

const CDM = "http://publications.europa.eu/ontology/cdm#";
const OWL = "http://www.w3.org/2002/07/owl#";
const ANNOTATION = "http://publications.europa.eu/ontology/annotation#";
const WORK =
  "http://publications.europa.eu/resource/cellar/55862dbf-c72b-11eb-a925-01aa75ed71a1";
const EXPRESSION = `${WORK}.0006`;
const fixture = readFileSync(
  new URL("__fixtures__/eu-branch-notice.xml", import.meta.url),
  "utf-8",
);
const parse = (xml: string) => parseEuCellarNotice(xml).unwrap();
const minimal = `<NOTICE type="branch"><WORK><URI><VALUE>${WORK}</VALUE></URI></WORK><EXPRESSION><URI><VALUE>${EXPRESSION}</VALUE></URI></EXPRESSION></NOTICE>`;
const errorReason = (xml: string) => {
  const result = parseEuCellarNotice(xml);
  expect(result.isErr()).toBe(true);
  return result.isErr() ? result.error.reason : null;
};

test("a captured branch notice states Work, language expression and XHTML items", () => {
  const result = parse(fixture);
  expect(result.workIri).toBe(WORK);
  expect(result.expressionIri).toBe(EXPRESSION);
  expect(result.manifestations).toEqual([
    {
      iri: `${EXPRESSION}.03`,
      type: "xhtml",
      items: [`${EXPRESSION}.03/DOC_1`],
    },
  ]);
  const statements = result.response.results.bindings;
  expect(statements).toContainEqual({
    s: { type: "uri", value: WORK },
    p: { type: "uri", value: `${CDM}resource_legal_id_celex` },
    o: { type: "literal", value: "32021D0914" },
  });
  expect(statements).toContainEqual({
    s: { type: "uri", value: WORK },
    p: { type: "uri", value: `${OWL}sameAs` },
    o: {
      type: "uri",
      value: "http://publications.europa.eu/resource/celex/32021D0914",
    },
  });
  expect(parse(fixture)).toEqual(result);
});

test("date annotations join the exact typed value and normalize through the metadata owner", () => {
  const notice = parse(fixture);
  const statements = notice.response.results.bindings;
  const date = {
    type: "literal",
    value: "2021-06-27",
    datatype: "http://www.w3.org/2001/XMLSchema#date",
  } as const;
  expect(statements).toContainEqual({
    s: { type: "uri", value: WORK },
    p: { type: "uri", value: `${CDM}resource_legal_date_entry-into-force` },
    o: date,
  });
  const axiom =
    statements.find(
      ({ p, o }) =>
        p.value === `${OWL}annotatedTarget` && o.value === date.value,
    )?.s ?? panic("Branch notice has no date axiom subject");
  expect(axiom.type).toBe("bnode");
  expect(statements).toContainEqual({
    s: axiom,
    p: { type: "uri", value: `${OWL}annotatedSource` },
    o: { type: "uri", value: WORK },
  });
  expect(statements).toContainEqual({
    s: axiom,
    p: { type: "uri", value: `${ANNOTATION}type_of_date` },
    o: {
      type: "literal",
      value: "{EV|http://publications.europa.eu/resource/authority/fd_335/EV}",
    },
  });
  const normalized = parseEuCellarMetadata({
    workIri: notice.workIri,
    expressionIri: notice.expressionIri,
    response: notice.response,
  }).unwrap();
  expect(normalized.publisherEvidence.inForce).toMatchObject({
    status: "stated",
    value: true,
  });
  expect(normalized.publisherEvidence.dates).toContainEqual(
    expect.objectContaining({
      lexicalValue: "2021-06-27",
      meaning: { type: "entry-into-force" },
      normalizedDate: "2021-06-27",
      scope: { type: "work" },
    }),
  );
  expect(normalized.publisherEvidence.dates).toContainEqual(
    expect.objectContaining({
      lexicalValue: "9999-12-31",
      meaning: { type: "end-of-validity" },
      normalizedDate: null,
    }),
  );
});

test("embedded Work, Expression and Manifestation facts never supply direct assertions", () => {
  const contaminated = fixture.replace(
    "</WORK>",
    "<WORK_HAS_EXPRESSION><EMBEDDED_NOTICE><WORK><RESOURCE_LEGAL_ID_CELEX><VALUE>WRONG-CELEX</VALUE></RESOURCE_LEGAL_ID_CELEX></WORK><EXPRESSION><EXPRESSION_TITLE><VALUE>Wrong title</VALUE></EXPRESSION_TITLE></EXPRESSION><MANIFESTATION><MANIFESTATION_TYPE><VALUE>wrong-format</VALUE></MANIFESTATION_TYPE></MANIFESTATION></EMBEDDED_NOTICE></WORK_HAS_EXPRESSION></WORK>",
  );
  expect(contaminated).toContain("WRONG-CELEX");
  expect(parse(contaminated)).toEqual(parse(fixture));
});

test("direct duplicate assertions survive translation and LANG stays attached to its value", () => {
  const xml = minimal.replace(
    "</WORK>",
    "<RESOURCE_LEGAL_ID_CELEX><LANG>en</LANG><VALUE>32021D0914</VALUE><VALUE>32021D0914</VALUE></RESOURCE_LEGAL_ID_CELEX></WORK>",
  );
  const statements = parse(xml).response.results.bindings;
  expect(statements).toHaveLength(2);
  expect(statements.at(0)?.o).toEqual({
    type: "literal",
    value: "32021D0914",
    "xml:lang": "en",
  });
  expect(statements.at(1)).toEqual(statements.at(0));
});

test("a notice with no direct statements cannot borrow embedded values", () => {
  expect(
    errorReason(
      minimal.replace(
        "</WORK>",
        "<EMBEDDED_NOTICE><WORK><RESOURCE_LEGAL_ID_CELEX><VALUE>32021D0914</VALUE></RESOURCE_LEGAL_ID_CELEX></WORK></EMBEDDED_NOTICE></WORK>",
      ),
    ),
  ).toBe("empty");
});

test("nonbranch, Formex, truncated and ambiguous scopes are refused", () => {
  expect(errorReason(fixture.replace('type="branch"', 'type="tree"'))).toBe(
    "unsupported-layout",
  );
  expect(errorReason("<ACT><TITLE>Formex</TITLE></ACT>")).toBe(
    "unsupported-layout",
  );
  expect(errorReason(fixture.slice(0, -20))).toBe("malformed");
  expect(
    errorReason(
      fixture.replace(
        "</NOTICE>",
        () => `<WORK><URI><VALUE>${WORK}</VALUE></URI></WORK></NOTICE>`,
      ),
    ),
  ).toBe("identity");
  expect(
    errorReason(
      fixture.replace(
        "</NOTICE>",
        () =>
          `<EXPRESSION><URI><VALUE>${EXPRESSION}</VALUE></URI></EXPRESSION></NOTICE>`,
      ),
    ),
  ).toBe("identity");
  expect(
    errorReason(fixture.replace(WORK, "https://example.eu/not-cellar")),
  ).toBe("identity");
});

test("publisher markup bounds cover branch notices before statement expansion", () => {
  expect(errorReason("x".repeat(8 * 1024 * 1024 + 1))).toBe("limits");
  expect(
    errorReason(
      `<NOTICE type="branch">${"<WORK>".repeat(65)}${"</WORK>".repeat(
        65,
      )}</NOTICE>`,
    ),
  ).toBe("limits");
  expect(
    errorReason(`<NOTICE type="branch">${"<VALUE/>".repeat(100_001)}</NOTICE>`),
  ).toBe("limits");
  const values = "<VALUE>date</VALUE>".repeat(150);
  const annotations =
    "<ANNOTATION><TYPE_OF_DATE>EV</TYPE_OF_DATE></ANNOTATION>".repeat(150);
  expect(
    errorReason(
      minimal.replace(
        "</WORK>",
        () => `<DATE>${values}${annotations}</DATE></WORK>`,
      ),
    ),
  ).toBe("limits");
});

test("annotations from distinct Work notices cannot share blank-node identities", () => {
  const otherWork =
    "http://publications.europa.eu/resource/cellar/66862dbf-c72b-11eb-a925-01aa75ed71a1";
  const original = parse(fixture)
    .response.results.bindings.filter(({ s }) => s.type === "bnode")
    .map(({ s }) => s.value);
  const other = parse(fixture.replaceAll(WORK, () => otherWork))
    .response.results.bindings.filter(({ s }) => s.type === "bnode")
    .map(({ s }) => s.value);
  expect(original.length).toBeGreaterThan(0);
  const originalIds = new Set(original);
  expect(other.every((id) => !originalIds.has(id))).toBe(true);
});

test("a manifestation cannot supply empty or unrelated item locations", () => {
  expect(
    errorReason(
      fixture.replace(`${EXPRESSION}.03/DOC_1`, "https://example.eu/unrelated"),
    ),
  ).toBe("identity");
  expect(errorReason(fixture.replace(`${EXPRESSION}.03/DOC_1`, ""))).toBe(
    "identity",
  );
});
