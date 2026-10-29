import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import * as cheerio from "cheerio";

import { hasUsableAst } from "@stll/legal-ast/document-ast";

import { euEcjAdapter } from "@/api/handlers/case-law/ingestion/adapters/eu-ecj";
import { SHELL_STEM } from "@/api/handlers/case-law/ingestion/parsers/__fixtures__/eu-ecj/corpus";
import { euEcjRetention } from "@/api/handlers/case-law/ingestion/retention/sources/eu-ecj";
import {
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/lib/legal-search/ingestion-types";
import { validateAst } from "@/api/lib/legal-search/parsers/validate-ast";

const PARSER_FIXTURES = new URL(
  "../../parsers/__fixtures__/eu-ecj/",
  import.meta.url,
);
const ADAPTER_FIXTURES = new URL(
  "../../adapters/__fixtures__/",
  import.meta.url,
);

/**
 * Pages the portal served where a decision would be: the adapter stores no
 * row for them, so they never reach the check.
 */
const SHELLS = new Set([
  `${SHELL_STEM}.html.gz`,
  "eu-ecj-61985CJ0214.cs.page.html.gz",
  "eu-ecj-61996TJ0183.lt.page.html.gz",
  "eu-ecj-61992TJ0027.sk.page.html.gz",
]);

/** Every recorded manifestation and portal page the adapter's tests read. */
const RECORDED = [
  ...Array.from(
    new Glob("*.html.gz").scanSync(PARSER_FIXTURES.pathname),
    (name) => ({ name, url: new URL(name, PARSER_FIXTURES) }),
  ),
  ...Array.from(
    new Glob("eu-ecj-*.html{,.gz}").scanSync(ADAPTER_FIXTURES.pathname),
    (name) => ({ name, url: new URL(name, ADAPTER_FIXTURES) }),
  ),
]
  .filter(({ name }) => !SHELLS.has(name))
  // File names, not language: a code-unit order keeps the list stable.
  .toSorted((left, right) => (left.name < right.name ? -1 : 1));

const readText = async (url: URL): Promise<string | undefined> => {
  const file = Bun.file(url);
  if (!(await file.exists())) {
    return undefined;
  }
  const bytes = await file.bytes();
  return new TextDecoder().decode(
    url.pathname.endsWith(".gz") ? Bun.gunzipSync(bytes) : bytes,
  );
};

/** `62022CJ0128.en.page.html.gz` and `eu-ecj-fulltext-en.html` name a language. */
const languageOf = (name: string): string =>
  /(?:^|[.-])(?<language>[a-z]{2})(?:\.page)?\.html/u.exec(name)?.groups?.[
    "language"
  ] ?? "en";

const reparse = euEcjAdapter.reparseStoredRaw;
if (reparse === undefined) {
  throw new TypeError("Expected eu-ecj to support stored replay");
}

/**
 * The decision the adapter builds from the recording, with the Formex
 * recorded beside it when there is one, so a row carrying every part is
 * what is projected.
 */
const builtDecision = async (fixture: (typeof RECORDED)[number]) => {
  const html = await readText(fixture.url);
  if (html === undefined) {
    throw new Error(`missing ${fixture.name}`);
  }
  const formex = await readText(
    new URL(fixture.name.replace(/\.html\.gz$/u, ".fmx.xml.gz"), fixture.url),
  );
  const outcome = await reparse({
    raw: new TextEncoder().encode(
      encodeSourceRawEnvelope({
        document: html,
        ...(formex === undefined || fixture.name.includes(".page.")
          ? {}
          : { formex }),
      }),
    ),
    contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    caseNumber: "C-128/22",
    sourceDocumentId: "62022CJ0128",
    language: languageOf(fixture.name),
    court: "Court of Justice",
    ecli: "ECLI:EU:C:2023:951",
    decisionDate: "2023-12-05",
    decisionType: "judgment",
    sourceUrl: null,
    documentUrl: null,
    metadata: { celex: "62022CJ0128" },
  });
  if (outcome.type !== "parsed") {
    throw new Error(`expected a parsed decision, got ${outcome.type}`);
  }
  return outcome.result;
};

describe("eu-ecj retention projection", () => {
  test("covers manifestations in several languages and a portal page", () => {
    const names = RECORDED.map(({ name }) => name);
    expect(names).toContain("62022CJ0128.en.page.html.gz");
    expect(new Set(names.map(languageOf)).size).toBeGreaterThan(4);
  });

  test.each(RECORDED.map((fixture) => [fixture.name, fixture] as const))(
    "the parsed decision keeps the manifestation's text: %s",
    async (_name, fixture) => {
      const decision = await builtDecision(fixture);
      const ast = decision.documentAst;
      // The parser's own check sends a parse it judged lossy to the
      // stripped-text fallback, which stores no AST and is not checked here.
      if (!hasUsableAst(ast)) {
        throw new Error("the adapter stored the stripped-text fallback");
      }
      const projection = await euEcjRetention.project(decision.sourceRaw ?? "");
      if (projection.type !== "source") {
        throw new Error(`expected a source projection, got ${projection.type}`);
      }

      const result = validateAst(
        projection.source,
        ast.blocks,
        projection.options,
      );

      expect(result.stats.missingWords).toEqual([]);
      expect(result.ok).toBe(true);
      // The projection measures something: a parse that lost the second half
      // of the decision fails against it.
      const halved = ast.blocks.slice(0, Math.ceil(ast.blocks.length / 2));
      expect(
        validateAst(projection.source, halved, projection.options).ok,
      ).toBe(false);
    },
  );

  test("the portal's furniture is outside the projected region", async () => {
    const page = await readText(
      new URL("62022CJ0128.en.page.html.gz", PARSER_FIXTURES),
    );
    const projection = await euEcjRetention.project(
      encodeSourceRawEnvelope({ document: page ?? "" }),
    );

    if (projection.type !== "source" || typeof projection.source === "string") {
      throw new Error("the ECJ projection states paragraphs");
    }
    const text = projection.source.paragraphs.join("\n");
    // The portal's own navigation, header and footer are not the decision.
    const chrome = cheerio
      .load(page ?? "")("nav, header, footer")
      .toArray()
      .map((element) =>
        cheerio.load(element).text().replace(/\s+/gu, " ").trim(),
      )
      .filter((label) => label.length > 20);
    expect(chrome.length).toBeGreaterThan(0);
    for (const label of chrome) {
      expect(text).not.toContain(label);
    }
  });

  test("an envelope without the manifestation is not one this source wrote", async () => {
    expect(
      await euEcjRetention.project(encodeSourceRawEnvelope({ listing: "{}" })),
    ).toEqual({ type: "unreadable", reason: "missing-text-part" });
  });
});
