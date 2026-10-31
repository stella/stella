import { expect, test } from "bun:test";
import { load as loadOriginal } from "cheerio";

import {
  digest,
  loaderModes,
  readLoaderFixtures,
} from "../tests/helpers/loader-equivalence-fixtures";
import { load } from "./load";
import goldens from "./loader-goldens.json";

// Captured with cheerio.load 1.2.0 before cutover. Input hashes also pin the corpus.
test("string loader preserves fixture serialization and text in every used mode", async () => {
  const actual = [];
  const archivedPaths = new Set(goldens.map(({ path }) => path));
  for (const { path, html } of await readLoaderFixtures()) {
    if (!archivedPaths.has(path)) {
      continue;
    }
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

const observeDocument = ($: ReturnType<typeof load>) => {
  const original = {
    html: digest($.html()),
    xml: digest($.xml()),
    text: digest($.text()),
  };
  $("body").append(
    "<table><tr><td>inserted &amp; text</table><noscript><p>fallback</p></noscript>",
  );
  return { ...original, mutated: digest($.html()) };
};

test("every current HTML and XML fixture matches the original loader in every mode", async () => {
  for (const { path, html } of await readLoaderFixtures()) {
    for (const mode of loaderModes) {
      expect(
        observeDocument(load(html, mode.options, mode.document)),
        `${path}: ${mode.name}`,
      ).toEqual(
        observeDocument(loadOriginal(html, mode.options, mode.document)),
      );
    }
  }
});
