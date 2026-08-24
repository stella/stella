/**
 * The public decision read drops every `plainText` a reader can rebuild
 * from the `inlines` beside it. That is lossless only while exactly one
 * function produces those fields, so this pins the round trip against
 * real publisher fixtures: sanitize (what ingestion stores), omit (what
 * the read sends), parse (what a reader gets back), compare.
 *
 * Two things used to move stored `plainText` away from its `inlines`,
 * and both are gone; the test exists so neither returns:
 *
 * - the ingestion normalizer collapsed spaced-letter runs by field name
 *   (`key === "plainText"`), so a court's "U S N E S E N Í" was stored
 *   as "USNESENÍ" while the inline text kept the spacing;
 * - each parser trimmed or whitespace-normalized on its own, and they
 *   disagreed — `eu-ecj` kept a space before a line break where
 *   `pl-courts` stripped it.
 *
 * `projectPlainText` now owns both, applied once at the storage
 * boundary. Adopting the `pl-courts` rule is a deliberate, accepted
 * divergence: an `eu-ecj` row stored before this is served without that
 * space. `plainText` feeds search and AI reads, never rendering offsets
 * — those index the raw `plainTextOf` axis, which nothing here touches.
 */

import { Glob } from "bun";
import { describe, expect, setDefaultTimeout, test } from "bun:test";

import type { DocumentAst } from "@stll/legal-ast/document-ast";
import {
  isDocumentAst,
  omitDerivablePlainText,
  parseDocumentAst,
} from "@stll/legal-ast/document-ast";

import { parseFindokDecisionXml } from "@/api/handlers/case-law/ingestion/parsers/at-findok";
import { parseRisDecisionXml } from "@/api/handlers/case-law/ingestion/parsers/at-ris";
import { parseEcjDecisionHtml } from "@/api/handlers/case-law/ingestion/parsers/eu-ecj";
import { parsePlDecisionContent } from "@/api/handlers/case-law/ingestion/parsers/pl-courts";
import { sanitizeResult } from "@/api/lib/legal-search/ingestion-normalization";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";

// Each eu-ecj fixture gunzips and parses one of the largest documents in
// the repo; the whole corpus runs in one test.
setDefaultTimeout(120_000);

const FIXTURES = new URL("../ingestion/parsers/__fixtures__/", import.meta.url);
const decoder = new TextDecoder();

/** The AST as ingestion would store it. */
const storedAst = (documentAst: DocumentAst, name = ""): DocumentAst => {
  const result: IngestionResult = {
    caseNumber: "1 Az 1/2020",
    court: "Test court",
    country: "AT",
    language: "de",
    metadata: {},
    rawHash: "0".repeat(64),
    documentAst,
  };
  const sanitized = sanitizeResult(result).documentAst;
  if (!isDocumentAst(sanitized)) {
    throw new Error(`sanitizeResult dropped the AST: ${name}`);
  }
  return sanitized;
};

/**
 * The AST as a reader receives and re-parses it. The JSON encode/decode
 * is the point, not a deep clone: it is what drops the omitted fields
 * the way the wire does.
 */
const roundTripped = (stored: DocumentAst): DocumentAst => {
  const wire = JSON.stringify(omitDerivablePlainText(stored));
  const parsed = parseDocumentAst(wire);
  if (parsed === null) {
    throw new Error("omitted AST failed to parse");
  }
  return parsed;
};

const countPieces = (ast: DocumentAst): number =>
  ast.blocks.reduce(
    (total, block) =>
      total +
      (block.type === "table"
        ? block.rows.reduce((cells, row) => cells + row.length, 0)
        : 1),
    0,
  );

const readGz = async (name: string, dir: URL): Promise<string> =>
  decoder.decode(Bun.gunzipSync(await Bun.file(new URL(name, dir)).bytes()));

const fixtureAsts = async (): Promise<{ name: string; ast: DocumentAst }[]> => {
  const asts: { name: string; ast: DocumentAst }[] = [];

  asts.push({
    name: "at-ris/jjt-1925",
    ast: parseRisDecisionXml({
      sourceDocumentId: "JJT_19250416_OGH0002_0030OB00270_2500000_000",
      caseNumber: "3Ob270/25",
      ecli: "ECLI:AT:OGH0002:1925:0030OB00270.25.0416.000",
      court: "OGH",
      decisionDate: "1925-04-16",
      decisionType: "beschluss",
      sourceUrl: "https://www.ris.bka.gv.at/",
      xml: await Bun.file(new URL("at-ris-jjt-1925.xml", FIXTURES)).text(),
    }).documentAst,
  });

  asts.push({
    name: "at-findok/bfg-2026",
    ast: parseFindokDecisionXml({
      caseNumber: "RV/7500368/2026",
      court: "BFG",
      decisionDate: "2026-07-14",
      decisionType: "bescheidbeschwerde - einzel - erkenntnis",
      sourceDocumentId: "b68202a0-55e4-4dea-9e93-971f0b71ae32",
      sourceUrl: "https://findok.bmf.gv.at/",
      xml: await Bun.file(new URL("at-findok-bfg-2026.xml", FIXTURES)).text(),
    }).documentAst,
  });

  // A line break preceded by a space: the case the two parsers used to
  // disagree about, and the reason `projectPlainText` owns the rule.
  asts.push({
    name: "pl-courts/space-before-break",
    ast: parsePlDecisionContent({
      caseNumber: "II SA/Wa 1/24",
      ecli: undefined,
      court: "WSA",
      decisionDate: "2024-01-01",
      decisionType: "wyrok",
      sourceUrl: "https://example.test/1",
      documentUrl: undefined,
      content: "<p>Alfa <br/>Beta <br/>Gamma</p>",
      keywords: [],
      statutes: [],
      documentId: "pl-1",
    }).documentAst,
  });

  const ecjDir = new URL("eu-ecj/", FIXTURES);
  const names = await Array.fromAsync(
    new Glob("*.html.gz").scan(ecjDir.pathname),
  );
  const ecjSources = await Promise.all(
    names.sort().map(async (name) => ({
      stem: name.replace(/\.html\.gz$/u, ""),
      html: await readGz(name, ecjDir),
    })),
  );
  for (const { html, stem } of ecjSources) {
    asts.push({
      name: `eu-ecj/${stem}`,
      ast: parseEcjDecisionHtml({
        caseNumber: "C-1/00",
        ecli: undefined,
        court: "CJEU",
        decisionDate: undefined,
        decisionType: undefined,
        sourceUrl: undefined,
        celex: stem.split(".")[0] ?? stem,
        html,
      }).documentAst,
    });
  }

  return asts;
};

describe("public decision AST plain text", () => {
  test("survives omit and refill for every fixture block", async () => {
    const asts = await fixtureAsts();
    expect(asts.length).toBeGreaterThan(10);

    let pieces = 0;
    for (const { name, ast } of asts) {
      const stored = storedAst(ast, name);
      pieces += countPieces(stored);
      expect(roundTripped(stored), name).toEqual(stored);
    }

    // Guards the corpus itself: a fixture set that shrank silently would
    // make the assertion above pass over nothing.
    expect(pieces).toBeGreaterThan(3000);
  });

  test("omission removes about a third of the largest fixture", async () => {
    const ecjDir = new URL("eu-ecj/", FIXTURES);
    const stored = storedAst(
      parseEcjDecisionHtml({
        caseNumber: "C-311/18",
        ecli: undefined,
        court: "CJEU",
        decisionDate: undefined,
        decisionType: undefined,
        sourceUrl: undefined,
        celex: "62018CJ0311",
        html: await readGz("62018CJ0311.en.html.gz", ecjDir),
      }).documentAst,
    );

    const full = JSON.stringify(stored).length;
    const sent = JSON.stringify(omitDerivablePlainText(stored)).length;

    expect(stored.blocks.length).toBeGreaterThan(400);
    expect(sent).toBeLessThan(full * 0.7);
  });
});
