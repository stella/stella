/**
 * The pl-uodo projection against the bodies the portal served, each built
 * into a decision by the adapter's own code and measured by the oracle
 * against what the projection reads back from the stored envelope.
 */
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { hasUsableAst } from "@stll/legal-ast/document-ast";

import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import {
  assemblePlUodoDecision,
  normalizePlUodoRow,
  plUodoBodyFrom,
  plUodoRawPartsOf,
} from "@/api/handlers/case-law/ingestion/adapters/pl-uodo";
import {
  RETENTION_PROJECTION_FAILURE,
  RETENTION_TEXT_ABSENCE,
  type RetentionProjection,
} from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { plUodoRetention } from "@/api/handlers/case-law/ingestion/retention/sources/pl-uodo";
import { readGzipJson } from "@/api/lib/gzip-json";
import { validateAst } from "@/api/lib/legal-search/parsers/validate-ast";
import { isRecord } from "@/api/lib/type-guards";

const FIXTURES = new URL("../../adapters/__fixtures__/", import.meta.url);
const PARSER_FIXTURES = new URL("../../parsers/__fixtures__/", import.meta.url);

/** The decision the adapter's tests build from the listing fixture. */
const DECISION_URN = "urn:ndoc:gov:pl:uodo:2022:dkn_5131_45";
/** A court ruling the same listing files, which carries no text. */
const RULING_URN = "urn:ndoc:court:pl:sa:2023:ii_sa-wa_996";

const recordOf = async (urn: string): Promise<Record<string, unknown>> => {
  const listed = await readGzipJson(
    new URL("pl-uodo-listing-2023.json.gz", FIXTURES),
  );
  const records: unknown[] = Array.isArray(listed) ? listed : [];
  return (
    records.filter(isRecord).find((record) => record["refid"] === urn) ??
    panic(`the listing fixture lost ${urn}`)
  );
};

const build = (
  listing: Record<string, unknown>,
  xml: string | undefined,
): IngestionResult => {
  const row = normalizePlUodoRow(listing);
  const body =
    xml === undefined
      ? undefined
      : plUodoBodyFrom(row, new TextEncoder().encode(xml));
  const built = assemblePlUodoDecision({
    row,
    body,
    rawParts: plUodoRawPartsOf(listing, body),
  });
  return built.type === "built" || built.type === "detail-unavailable"
    ? built.decision
    : panic(`expected a decision, got ${built.type}`);
};

const projectionOf = async (
  decision: IngestionResult,
): Promise<RetentionProjection> => {
  if (plUodoRetention.type !== "checked") {
    return panic("pl-uodo is declared checked");
  }
  return await plUodoRetention.project(
    decision.sourceRaw ?? panic("the decision stored no source raw"),
  );
};

const retentionOf = async (decision: IngestionResult) => {
  const ast = decision.documentAst;
  if (!hasUsableAst(ast)) {
    return panic("the decision built no document");
  }
  const projection = await projectionOf(decision);
  if (projection.type !== "source") {
    return panic(`expected publisher text, got ${projection.type}`);
  }
  return validateAst(projection.source, ast.blocks, projection.options);
};

describe("pl-uodo retention projection", () => {
  // Recorded bodies: the long decision the adapter's tests use and the short
  // one the parser's tests use, each built on the adapter's listing record.
  test.each([
    ["pl-uodo-dkn-5131-45-2022.xml"],
    ["pl-uodo-zsoss-440-82-2019.xml"],
  ])("%s retains the publisher's text", async (fixture) => {
    const xml = await Bun.file(new URL(fixture, PARSER_FIXTURES)).text();
    const result = await retentionOf(build(await recordOf(DECISION_URN), xml));
    console.info(
      `pl-uodo ${fixture}: retainedPct=${result.stats.retainedPct.toFixed(1)} missingWords=${String(result.stats.missingWords.length)}`,
    );
    expect(result.ok).toBe(true);
  });

  test("a text in an element the parser has no rule for is measured too", async () => {
    // The adapter's own synthetic case: an unknown element the parser keeps.
    const xml = (
      await Bun.file(
        new URL("pl-uodo-dkn-5131-45-2022.xml", PARSER_FIXTURES),
      ).text()
    ).replace("</xPart>", "<xUnknown>tekst nowego elementu</xUnknown></xPart>");
    const result = await retentionOf(build(await recordOf(DECISION_URN), xml));
    expect(result.ok).toBe(true);
  });

  test("a decision stored without its body has no publisher text", async () => {
    expect(
      await projectionOf(build(await recordOf(DECISION_URN), undefined)),
    ).toEqual({
      type: "no-text",
      reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED,
    });
  });

  test("a court ruling the portal files without text has no publisher text", async () => {
    expect(
      await projectionOf(build(await recordOf(RULING_URN), undefined)),
    ).toEqual({
      type: "no-text",
      reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED,
    });
  });

  test("a raw that is not the adapter's envelope is unreadable", async () => {
    if (plUodoRetention.type !== "checked") {
      panic("pl-uodo is declared checked");
    }
    expect(await plUodoRetention.project("<xPart/>")).toEqual({
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    });
  });

  test("a body without the decision root is unreadable", async () => {
    if (plUodoRetention.type !== "checked") {
      panic("pl-uodo is declared checked");
    }
    expect(
      await plUodoRetention.project(
        JSON.stringify({
          version: 1,
          parts: { listing: "{}", "body-xml": "<html/>" },
        }),
      ),
    ).toEqual({
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.MISSING_TEXT_PART,
    });
  });
});
