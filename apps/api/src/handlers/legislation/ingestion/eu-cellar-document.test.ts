import { expect, test } from "bun:test";
import * as cheerio from "cheerio";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import * as v from "valibot";

import { documentAstSchema } from "@stll/legal-ast/document-ast";

import { toSafeId } from "@/api/lib/branded-types";
import { stripDangerousChars } from "@/api/lib/legal-search/corpus-sanitize";
import { validateAst } from "@/api/lib/legal-search/parsers/validate-ast";

import {
  parseEuCellarDocument,
  parseEuCellarDocumentBytes,
  reparseEuCellarDocument,
} from "./eu-cellar-document";

const sourceId = toSafeId<"legislationSource">(
  "0198e331-e578-7000-8000-000000000f01",
);
const WORK =
  "http://publications.europa.eu/resource/cellar/55862dbf-c72b-11eb-a925-01aa75ed71a1";
const manifestationIri = `${WORK}.0006.03`;
const itemIri = `${manifestationIri}/DOC_1`;
const fixture = (name: string) =>
  readFileSync(new URL(`__fixtures__/${name}`, import.meta.url), "utf-8");
const original = () => ({
  sourceId,
  noticeXml: fixture("eu-branch-notice.xml"),
  manifestationIri,
  itemIri,
  content: { type: "xhtml" as const, html: fixture("eu-annex.xhtml") },
  origin: "live" as const,
});

test("a publisher notice and XHTML produce one original expression with raw evidence and annexes", () => {
  const input = original();
  const result = parseEuCellarDocument(input).unwrap();
  expect(result.type).toBe("document");
  if (result.type !== "document") {
    return;
  }
  const { document } = result;
  expect(document.eli).toBe(WORK);
  expect(document.identifiers).toContain("32021D0914");
  expect(document.expression).toEqual({
    publisherId: `cellar:${WORK}.0006`,
    kind: "promulgated",
  });
  expect(document.documentType).toBe("decision");
  expect(document.language).toBe("en");
  expect(document.status).toBe("unknown");
  expect(document.version).toEqual({
    type: "invalid-window",
    validFrom: null,
    end: { type: "open" },
    basis: "missing-start",
  });
  expect(document.fulltext).toContain("STANDARD CONTRACTUAL CLAUSES");
  expect(document.metadata.publisherEvidence.inForce).toMatchObject({
    status: "stated",
    value: true,
  });
  expect(document.metadata.publisherEvidence.dates).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        meaning: { type: "entry-into-force" },
        normalizedDate: "2021-06-27",
      }),
      expect.objectContaining({
        lexicalValue: "9999-12-31",
        normalizedDate: null,
      }),
    ]),
  );
  const raw: unknown = JSON.parse(document.sourceRaw);
  expect(raw).toMatchObject({
    schema: "eu-cellar-document-v1",
    noticeXml: input.noticeXml,
    content: input.content,
    manifestationIri,
    itemIri,
  });
  expect(parseEuCellarDocument(input).unwrap()).toEqual(result);
  expect(
    parseEuCellarDocument({
      ...input,
      content: {
        type: "xhtml",
        html: input.content.html.replace(
          "STANDARD CONTRACTUAL CLAUSES",
          "CHANGED CONTRACTUAL CLAUSES",
        ),
      },
    }).unwrap(),
  ).not.toEqual(result);
});

test("complete publisher responses retain the final annex without excerpt assumptions", () => {
  const full = (name: string) =>
    gunzipSync(
      readFileSync(new URL(`__fixtures__/${name}`, import.meta.url)),
    ).toString("utf-8");
  const html = full("eu-scc-full.xhtml.gz");
  const result = parseEuCellarDocument({
    ...original(),
    noticeXml: full("eu-scc-full.notice.xml.gz"),
    content: { type: "xhtml", html },
  }).unwrap();
  expect(result.type).toBe("document");
  if (result.type !== "document") {
    return;
  }
  expect(v.safeParse(documentAstSchema, result.document.ast).success).toBe(
    true,
  );
  expect(result.document.fulltext).toContain("STANDARD CONTRACTUAL CLAUSES");
  expect(result.document.fulltext).toContain("LIST OF PARTIES");
  expect(result.document.fulltext).toContain("SUPERVISORY AUTHORITY");
  expect(result.document.fulltext).toContain(
    "TECHNICAL AND ORGANISATIONAL MEASURES",
  );
  const $ = cheerio.load(html, { xml: true });
  const publisherText = $(".eli-container")
    .filter((_, element) => $(element).parents(".eli-container").length === 0)
    .toArray()
    .map((element) => $.html(element))
    .join("\n");
  const retention = validateAst(publisherText, result.document.ast.blocks);
  expect(retention.stats.retainedPct).toBeGreaterThanOrEqual(99);
  expect(retention.stats.missingWords).toEqual([]);
});

test.each(["formex", "archive"] as const)(
  "unsupported %s is a typed refusal",
  (type) => {
    const result = parseEuCellarDocument({ ...original(), content: { type } });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toMatchObject({ reason: "unsupported-format" });
    }
  },
);

test.each([
  { manifestationIri: `${WORK}.0006.99` },
  { itemIri: `${manifestationIri}/OTHER` },
  { itemIri: "https://example.test/DOC_1" },
])("unstated manifestation/item %p is refused", (change) => {
  expect(parseEuCellarDocument({ ...original(), ...change }).isErr()).toBe(
    true,
  );
});

test("a second item is a typed multi-file refusal rather than a partial text", () => {
  const input = original();
  const noticeXml = input.noticeXml.replace(
    "</MANIFESTATION>",
    () =>
      `<MANIFESTATION_HAS_ITEM><URI><VALUE>${manifestationIri}/DOC_2</VALUE></URI></MANIFESTATION_HAS_ITEM></MANIFESTATION>`,
  );
  const result = parseEuCellarDocument({ ...input, noticeXml });
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error).toMatchObject({ reason: "manifestation" });
  }
});

test("a root manifestation must be linked from the stated language expression", () => {
  const input = original();
  const $ = cheerio.load(input.noticeXml, { xml: true });
  $("NOTICE > EXPRESSION > EXPRESSION_MANIFESTED_BY_MANIFESTATION").remove();
  const result = parseEuCellarDocument({ ...input, noticeXml: $.xml() });
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error).toMatchObject({ reason: "manifestation" });
  }
});

test("a communication is handed to the soft-law owner without a legislation document", () => {
  const input = original();
  const noticeXml = input.noticeXml.replaceAll(
    "resource-type/DEC_IMPL",
    "resource-type/COMMUNIC",
  );
  expect(parseEuCellarDocument({ ...input, noticeXml }).unwrap()).toEqual({
    type: "soft-law",
    owner: "soft-law",
  });
});

test("corrigenda and non-English expressions are refused without altering another Work", () => {
  const input = original();
  const correction = input.noticeXml.replaceAll(
    "resource-type/DEC_IMPL",
    "resource-type/CORRIGENDUM",
  );
  expect(
    parseEuCellarDocument({ ...input, noticeXml: correction }).isErr(),
  ).toBe(true);
  const italian = input.noticeXml.replaceAll(
    "authority/language/ENG",
    "authority/language/ITA",
  );
  expect(parseEuCellarDocument({ ...input, noticeXml: italian }).isErr()).toBe(
    true,
  );
});

test("live bytes retain transport fingerprints and stored replay keeps the original observation", () => {
  const input = original();
  const result = parseEuCellarDocumentBytes({
    sourceId,
    manifestationIri,
    itemIri,
    origin: "live",
    notice: {
      bytes: new TextEncoder().encode(input.noticeXml),
      contentType: "application/xml; charset=utf-8",
    },
    content: {
      bytes: new TextEncoder().encode(input.content.html),
      contentType: "application/xhtml+xml; charset=utf-8",
    },
  }).unwrap();
  expect(result.type).toBe("document");
  if (result.type !== "document") {
    return;
  }
  expect(result.document.sourceRaw).toContain('"charset":"utf-8"');
  const storedRaw = stripDangerousChars(result.document.sourceRaw);
  const replay = reparseEuCellarDocument({ sourceId, raw: storedRaw }).unwrap();
  expect(replay.type).toBe("document");
  if (replay.type !== "document") {
    return;
  }
  expect(replay.document.rawHash).toBe(result.document.rawHash);
  expect(replay.document.sourceRaw).toBe(storedRaw);
  expect(replay.document.origin).toBe("stored-raw-replay");
  expect(replay.document.fulltext).toBe(result.document.fulltext);
});

test("a stated consolidation keeps the base Work aliases and its own expression identity", () => {
  const input = original();
  const textWork =
    "http://publications.europa.eu/resource/cellar/22222222-2222-4222-8222-222222222222";
  const $ = cheerio.load(input.noticeXml, { xml: true });
  $("NOTICE > WORK").append(
    `<RESOURCE_LEGAL_CONSOLIDATED_BY_ACT_CONSOLIDATED type="link"><URI><VALUE>${textWork}</VALUE></URI></RESOURCE_LEGAL_CONSOLIDATED_BY_ACT_CONSOLIDATED>`,
  );
  const baseNoticeXml = $.xml();
  const noticeXml = input.noticeXml
    .replaceAll(WORK, () => textWork)
    .replaceAll("32021D0914", "02021D0914-20210607")
    .replaceAll("resource-type/DEC_IMPL", "resource-type/CONS_TEXT");
  const result = parseEuCellarDocument({
    ...input,
    baseNoticeXml,
    noticeXml,
    manifestationIri: `${textWork}.0006.03`,
    itemIri: `${textWork}.0006.03/DOC_1`,
  }).unwrap();
  expect(result.type).toBe("document");
  if (result.type !== "document") {
    return;
  }
  expect(result.document.eli).toBe(WORK);
  expect(result.document.expression).toEqual({
    publisherId: `cellar:${textWork}.0006`,
    kind: "consolidation",
  });
  expect(result.document.identifiers).toContain("32021D0914");
  expect(result.document.identifiers).not.toContain("02021D0914-20210607");
  expect(result.document.version.validFrom).toBeNull();
  expect(
    parseEuCellarDocument({
      ...input,
      baseNoticeXml: input.noticeXml,
      noticeXml,
      manifestationIri: `${textWork}.0006.03`,
      itemIri: `${textWork}.0006.03/DOC_1`,
    }).isErr(),
  ).toBe(true);
});

test.each(["not json", "{}", '{"schema":"unsupported"}'])(
  "an unsupported raw snapshot %p is refused",
  (raw) => {
    expect(reparseEuCellarDocument({ sourceId, raw }).isErr()).toBe(true);
  },
);
