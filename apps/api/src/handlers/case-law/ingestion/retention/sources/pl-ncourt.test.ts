/**
 * Every captured judgment document, built by the adapter and checked against
 * what the projection reads from the stored XML.
 */
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { hasUsableAst } from "@stll/legal-ast/document-ast";

import {
  assemblePlNcourtDecision,
  readPlNcourtDetail,
  readPlNcourtListing,
} from "@/api/handlers/case-law/ingestion/adapters/pl-ncourt";
import type { PlNcourtBuild } from "@/api/handlers/case-law/ingestion/adapters/pl-ncourt";
import { plNcourtRetention } from "@/api/handlers/case-law/ingestion/retention/sources/pl-ncourt";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";
import { validateAst } from "@/api/lib/legal-search/parsers/validate-ast";
import { encodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";

const FIXTURES = new URL("../../adapters/__fixtures__/", import.meta.url);

const PAIR = "155020000001003_II_Ca_000236_2018_Uz_2018-03-22_001";
const REASONS = "154010150001006_II_K_000466_2017_Uz_2018-03-22_001";
const LIST_DOC = "151020200002521_V_P_000335_2013_Uz_2015-11-02_001";
const TABLE_DOC = "150515000000503_I_C_000697_2021_Uz_2023-03-27_002";

const fixture = async (name: string): Promise<string> => {
  const bytes = await Bun.file(new URL(name, FIXTURES)).bytes();
  return new TextDecoder().decode(
    name.endsWith(".gz") ? Bun.gunzipSync(bytes) : bytes,
  );
};

const rowXml = (fields: Record<string, string>): string =>
  `<judgement>${Object.entries(fields)
    .map(([name, value]) => `<${name}>${value}</${name}>`)
    .join("")}</judgement>`;

/** The observation the pipeline checks: a decision, or a supplement's document. */
const observed = (outcome: PlNcourtBuild): IngestionResult => {
  switch (outcome.type) {
    case "built":
      return outcome.decision;
    case "supplement":
      return outcome.supplement.document;
    case "unkeyable":
      return panic("the fixture did not key");
    default:
      outcome satisfies never;
      return panic("unhandled build outcome");
  }
};

/** Each captured document with the record the adapter's own tests pair it with. */
const DOCUMENTS: readonly {
  id: string;
  build: () => Promise<PlNcourtBuild>;
}[] = [
  {
    id: PAIR,
    build: async () => {
      const listing =
        readPlNcourtListing(await fixture("pl-ncourt-listing-signature.xml")) ??
        panic("the signature listing did not read");
      return assemblePlNcourtDecision({
        listingXml:
          listing.fragments[0] ?? panic("the signature lists nothing"),
        detailXml: await fixture(`pl-ncourt-detail-${PAIR}.xml`),
        contentXml: await fixture(`pl-ncourt-content-${PAIR}.xml.gz`),
      });
    },
  },
  {
    id: REASONS,
    build: async () => {
      const detailXml = await fixture(`pl-ncourt-detail-${REASONS}.xml`);
      const detail = readPlNcourtDetail(detailXml);
      if (detail?.type !== "record") {
        return panic("the reasons record did not read");
      }
      return assemblePlNcourtDecision({
        listingXml: rowXml({
          id: REASONS,
          signature: detail.fields.get("signature") ?? "",
          date: detail.fields.get("date") ?? "",
          courtId: detail.fields.get("courtId") ?? "",
          type: detail.fields.get("type") ?? "",
        }),
        detailXml,
        contentXml: await fixture(`pl-ncourt-content-${REASONS}.xml.gz`),
      });
    },
  },
  ...[LIST_DOC, TABLE_DOC].map((id) => ({
    id,
    build: async () =>
      assemblePlNcourtDecision({
        listingXml: rowXml({ id, signature: "I C 1/15", courtId: "15502000" }),
        detailXml: await fixture(`pl-ncourt-detail-${PAIR}.xml`),
        contentXml: await fixture(`pl-ncourt-content-${id}.xml.gz`),
      }),
  })),
];

const project = async (sourceRaw: string | undefined) => {
  if (plNcourtRetention.type !== "checked") {
    return panic("pl-ncourt is a checked source");
  }
  return await plNcourtRetention.project(
    sourceRaw ?? panic("the decision stores no raw"),
  );
};

describe("pl-ncourt retention", () => {
  for (const { id, build } of DOCUMENTS) {
    test(`${id} keeps the text the court's XML states`, async () => {
      const decision = observed(await build());
      const ast = decision.documentAst;
      if (!hasUsableAst(ast)) {
        panic(`${id} built no document`);
      }
      const projection = await project(decision.sourceRaw);
      if (projection.type !== "source") {
        panic(`${id}: ${projection.type}`);
      }
      const result = validateAst(
        projection.source,
        ast.blocks,
        projection.options,
      );
      console.info(
        `pl-ncourt ${id}: retainedPct=${result.stats.retainedPct.toFixed(1)} missingWords=${String(result.stats.missingWords.length)}`,
      );
      expect(result.ok).toBe(true);
    });
  }

  test("the record parts are not read as the judgment's text", async () => {
    const projection = await project(
      encodeSourceRawEnvelope({
        listing: "<judgement><signature>I C 1/15</signature></judgement>",
        document:
          "<xPart><xName>Wyrok</xName><xText>Sąd orzekł.</xText></xPart>",
      }),
    );
    // The root's own name labels the document rather than its text.
    expect(projection).toEqual({
      type: "source",
      source: { type: "paragraphs", paragraphs: ["Sąd orzekł."] },
      options: { wordComparisonText: "Sąd orzekł." },
    });
  });

  test("a judgment without a document, an error answer, a raw that is no envelope", async () => {
    expect(
      await project(
        encodeSourceRawEnvelope({
          listing: "<judgement/>",
          "document-status": "not-found",
        }),
      ),
    ).toEqual({ type: "no-text", reason: "not-published" });
    expect(
      await project(
        encodeSourceRawEnvelope({ document: "<error>500</error>" }),
      ),
    ).toEqual({ type: "unreadable", reason: "missing-text-part" });
    expect(await project("<xPart/>")).toEqual({
      type: "unreadable",
      reason: "unreadable-envelope",
    });
  });
});
