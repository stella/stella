import { describe, expect, test } from "bun:test";
import * as cheerio from "cheerio";
import { readdir } from "node:fs/promises";

import { readRtfString } from "@/api/lib/legal-search/parsers/rtf-reader";
import {
  buildValidationHtml,
  validateAst,
} from "@/api/lib/legal-search/parsers/validate-ast";

import { parseUsDecisionHtml, usDocumentLinesOf } from "./cz-us";

const FIXTURES = new URL("__fixtures__/", import.meta.url);
const SNAPSHOT = new URL(
  "__snapshots__/cz-us-parser-output.snapshot.json.gz",
  import.meta.url,
);

const fixtureNames = async (): Promise<string[]> =>
  (await readdir(FIXTURES.pathname))
    .filter((name) => /^cz-us-.*\.html\.gz$/u.test(name))
    .toSorted();

const gunzipText = async (url: URL): Promise<string> =>
  new TextDecoder().decode(
    Bun.gunzipSync(new Uint8Array(await Bun.file(url).arrayBuffer())),
  );

const inputFor = (name: string, html: string) => ({
  html,
  caseNumber: name.slice("cz-us-".length, -".html.gz".length),
  ecli: undefined,
  court: "Ústavní soud",
  decisionDate: undefined,
  decisionType: undefined,
});

describe("committed CZ ÚS fixtures", () => {
  test("retain their complete serialized parser output", async () => {
    const names = await fixtureNames();
    const snapshots = JSON.parse(await gunzipText(SNAPSHOT)) as Record<
      string,
      string
    >;

    expect(Object.keys(snapshots).toSorted()).toEqual(names);
    for (const name of names) {
      const html = await gunzipText(new URL(name, FIXTURES));
      expect(JSON.stringify(parseUsDecisionHtml(inputFor(name, html)))).toBe(
        snapshots[name],
      );
    }
  });

  test("produce identical diagnostics from paragraphs and validation HTML", async () => {
    for (const name of await fixtureNames()) {
      const html = await gunzipText(new URL(name, FIXTURES));
      const $ = cheerio.load(html);
      const rtf = $("input#docContentHidden").attr("value") ?? "";
      expect(rtf.trim()).not.toBe("");

      const paragraphs = usDocumentLinesOf(readRtfString(rtf)).map((line) =>
        line.kind === "body" ? line.value.plainText : line.note.value.plainText,
      );
      const blocks = parseUsDecisionHtml(inputFor(name, html)).documentAst
        .blocks;

      expect(validateAst({ type: "paragraphs", paragraphs }, blocks)).toEqual(
        validateAst(buildValidationHtml(paragraphs), blocks),
      );
    }
  });
});
