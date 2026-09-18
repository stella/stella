/**
 * What the row keeps from the Cellar branch notice, and the two query shapes
 * that reach it.
 *
 * Driven from the committed captures of one decision in two languages. That
 * pairing is the point: a row is one expression, and the tests below are what
 * hold the notice to being read per expression rather than per work.
 */

import { describe, expect, test } from "bun:test";

import {
  buildListingQuery,
  ecjRawParts,
  euEcjAdapter,
} from "@/api/handlers/case-law/ingestion/adapters/eu-ecj";
import type { EcjSparqlBinding } from "@/api/handlers/case-law/ingestion/adapters/eu-ecj";
import { parseFormexBibliography } from "@/api/handlers/case-law/ingestion/parsers/eu-ecj-formex-bibliography";
import { parseEcjNotice } from "@/api/handlers/case-law/ingestion/parsers/eu-ecj-notice";
import { DECISION_JUDGE_ROLE } from "@/api/handlers/case-law/judges/consts";
import {
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/lib/legal-search/ingestion-types";
import type { StoredRawReparseInput } from "@/api/lib/legal-search/ingestion-types";

const CELEX = "62022CJ0128";
const EXPRESSION = "cc021804-9350-11ee-8aa6-01aa75ed71a1.0011";

const gunzipText = async (url: URL): Promise<string> =>
  new TextDecoder().decode(Bun.gunzipSync(await Bun.file(url).bytes()));

const noticeEn = await gunzipText(
  new URL("__fixtures__/eu-ecj-notice-en.xml.gz", import.meta.url),
);
const noticeEl = await gunzipText(
  new URL("__fixtures__/eu-ecj-notice-el.xml.gz", import.meta.url),
);
const documentEn = await gunzipText(
  new URL(
    `../parsers/__fixtures__/eu-ecj/${CELEX}.en.html.gz`,
    import.meta.url,
  ),
);
const formexEn = await gunzipText(
  new URL(
    `../parsers/__fixtures__/eu-ecj/${CELEX}.en.fmx.xml.gz`,
    import.meta.url,
  ),
);

const binding = {
  ecli: { type: "literal", value: "ECLI:EU:C:2023:951" },
  date: { type: "literal", value: "2023-12-05" },
  celex: { type: "literal", value: CELEX },
  type: {
    type: "uri",
    value: "http://publications.europa.eu/ontology/cdm#judgement",
  },
  language: {
    type: "uri",
    value: "http://publications.europa.eu/resource/authority/language/ENG",
  },
  manifestation: {
    type: "uri",
    value: `http://publications.europa.eu/resource/cellar/${EXPRESSION}.05`,
  },
} as const satisfies EcjSparqlBinding;

const reparse = euEcjAdapter.reparseStoredRaw;
if (!reparse) {
  throw new TypeError("Expected eu-ecj to implement reparseStoredRaw");
}

const storedFrom = (
  raw: string,
  overrides: Partial<StoredRawReparseInput> = {},
): StoredRawReparseInput => ({
  raw: new TextEncoder().encode(raw),
  contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  caseNumber: "C-128/22",
  sourceDocumentId: `${CELEX}:en`,
  language: "en",
  court: "",
  ecli: binding.ecli.value,
  decisionDate: binding.date.value,
  decisionType: "judgment",
  sourceUrl: `https://eur-lex.europa.eu/legal-content/EN/ALL/?uri=CELEX:${CELEX}`,
  documentUrl: `https://publications.europa.eu/resource/cellar/${EXPRESSION}.05`,
  metadata: { celex: CELEX },
  ...overrides,
});

const storedEnvelope = (notice: string | undefined): string =>
  encodeSourceRawEnvelope(
    ecjRawParts({
      binding: { ...binding },
      html: documentEn,
      notice,
      formex: formexEn,
    }),
  );

const decisionFrom = async (notice: string | undefined) => {
  const outcome = await reparse(storedFrom(storedEnvelope(notice)));
  if (outcome.type !== "parsed") {
    throw new TypeError(`Expected parsed, got ${outcome.type}`);
  }
  return outcome.result;
};

describe("the branch notice is read per expression", () => {
  test("the translated fields differ between two notices of one work", () => {
    const english = parseEcjNotice(noticeEn);
    const greek = parseEcjNotice(noticeEl);

    // Both notices are of the same work, so everything keyed on the work is
    // identical and everything the Office renders into the negotiated
    // language is not. A row storing its neighbour's notice would carry the
    // second column under the first row's identity.
    expect(english.celex).toBe(greek.celex ?? "");
    expect(english.rapporteur).toBe(greek.rapporteur ?? "");
    expect(english.caseIdentifier).toBe("Case C-128/22");
    expect(greek.caseIdentifier).toBe("Υπόθεση C-128/22");
    expect(greek.title).not.toBe(english.title);
  });

  test("the court is read from the authority code, not the rendered label", () => {
    // `PREFLABEL` is translated, so a court read from it would file this one
    // judgment under twenty-four different courts.
    const greek = parseEcjNotice(noticeEl);

    expect(greek.courtCode).toBe("CJ");
  });
});

describe("what the notice adds to a stored row", () => {
  test("names the court outright instead of inferring it from the ECLI", async () => {
    const decision = await decisionFrom(noticeEn);

    expect(decision.court).toBe("Court of Justice");
  });

  test("emits the rapporteur and the Advocate General as the bench", async () => {
    const decision = await decisionFrom(noticeEn);

    expect(decision.judges).toEqual([
      { role: DECISION_JUDGE_ROLE.RAPPORTEUR, nameAsPrinted: "Safjan" },
      { role: DECISION_JUDGE_ROLE.ADVOCATE_GENERAL, nameAsPrinted: "Emiliou" },
    ]);
  });

  test("keeps the publisher's own cited-works list", async () => {
    const decision = await decisionFrom(noticeEn);

    // The ground truth citation extraction is measured against, which is why
    // it is carried beside the row rather than stored on it.
    expect(decision.publisherCitedCases).toContain("62015CJ0601");
    expect(decision.publisherCitedCases?.length).toBeGreaterThan(40);
  });

  test("keeps both classification trees, the referral and the case file", async () => {
    const decision = await decisionFrom(noticeEn);

    expect(decision.metadata).toMatchObject({
      procedureLanguage: "NLD",
      dossier: "case:C-128/22",
      publishedInReports: true,
    });
    expect(decision.metadata["caseLawDirectory"]).toContainEqual({
      code: "1.09.03.02",
      label:
        "Restrictions justified on grounds of public policy, public security or public health",
    });
    expect(decision.metadata["caseLawDirectoryNew"]).toContainEqual({
      code: "4.06.01.02",
      label: "Crossing of external borders",
    });
    expect(decision.metadata["nationalJudgment"]).toContain(
      "Nederlandstalige rechtbank van eerste aanleg Brussel",
    );
  });

  test("a row without one keeps its document and states no bench", async () => {
    // The notice is one request of three, and the Office does not serve one
    // for every work. An absent bench is not an empty one: the pipeline
    // replaces a decision's judges only where an observation carries the
    // field, so an empty list would erase what an earlier pass recovered.
    const decision = await decisionFrom(undefined);

    expect(decision.judges).toBeUndefined();
    expect(decision.publisherCitedCases).toBeUndefined();
    expect(decision.fulltext?.length).toBeGreaterThan(100);
  });
});

describe("the Formex bibliography", () => {
  test("states the docket and the court without a language", () => {
    // Both are rendered into the negotiated language by the notice, so this
    // is the only surface that states them the same way in all 24 rows.
    const bibliography = parseFormexBibliography(formexEn);

    expect(bibliography.caseNumber).toBe("C-128/22");
    expect(bibliography.author).toBe("CJ");
  });
});

describe("a row stored before the envelope", () => {
  test("re-parses from the bare manifestation it holds", async () => {
    // Every row this adapter wrote before it had an envelope holds the XHTML
    // and nothing else, under the content type of the day. Dropping that
    // reader would make the whole stored corpus unreplayable.
    const outcome = await reparse(
      storedFrom(documentEn, {
        contentType: "application/xhtml+xml; stella-storage=verbatim",
      }),
    );

    if (outcome.type !== "parsed") {
      throw new TypeError(`Expected parsed, got ${outcome.type}`);
    }
    expect(outcome.result.fulltext?.length).toBeGreaterThan(100);
    // Nothing the notice would have stated, because no notice was kept.
    expect(outcome.result.judges).toBeUndefined();
  });
});

describe("the listing query binds CELEX the way the endpoint answers", () => {
  test("binds the CELEX as a typed string literal", () => {
    // `cdm:resource_legal_id_celex` holds `xsd:string`-typed literals. A plain
    // literal is a different RDF term, so the endpoint answers 200 with no
    // rows and a decision it holds reads as one it never published.
    const query = buildListingQuery({
      dateFrom: "1952-01-01",
      dateTo: "2026-01-01",
      celexFilter: [CELEX],
    });

    expect(query).toContain(`VALUES ?celex { "${CELEX}"^^xsd:string }`);
    expect(query).toContain("PREFIX xsd:");
  });

  test("never filters an unbound CELEX through STR()", () => {
    // That shape puts the whole CELEX index inside the filter and the
    // endpoint stops answering, which is indistinguishable from an outage.
    const query = buildListingQuery({
      dateFrom: "1952-01-01",
      dateTo: "2026-01-01",
      celexFilter: [CELEX],
    });

    expect(query).not.toContain("STR(?celex)");
  });

  test("emits no CELEX clause when no CELEX was asked for", () => {
    // An empty clause would turn a lookup for named decisions into a sweep of
    // the whole corpus, so the date range has to be the only bound left.
    const query = buildListingQuery({
      dateFrom: "2024-01-01",
      dateTo: "2024-01-31",
    });

    expect(query).not.toContain("VALUES ?celex");
    expect(query).toContain('FILTER(STR(?date) >= "2024-01-01")');
  });
});
