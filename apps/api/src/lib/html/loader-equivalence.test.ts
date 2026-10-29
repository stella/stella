import { expect, test } from "bun:test";

import { load } from "@stll/html";

import {
  digest,
  loaderModes,
  readLoaderFixtures,
} from "./loader-equivalence-fixtures";
import goldens from "./loader-goldens.json";

// Captured with cheerio.load 1.2.0 before cutover. Input hashes also pin the corpus.
test("string loader preserves fixture serialization and text in every used mode", async () => {
  const actual = [];
  for (const { path, html } of await readLoaderFixtures()) {
    for (const mode of loaderModes) {
      const $ = load(html, mode.options, mode.document);
      const original = {
        html: digest($.html()),
        xml: digest($.xml()),
        text: digest($.text()),
      };
      $("body").append(
        "<table><tr><td>inserted &amp; text</table><noscript><p>fallback</p></noscript>",
      );
      actual.push({
        path,
        mode: mode.name,
        input: digest(html),
        ...original,
        mutated: digest($.html()),
      });
    }
  }
  expect(actual).toEqual(goldens);
});
