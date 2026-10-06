import { describe, expect, test } from "bun:test";

import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "./case-law-decision-route";
import { resolveLegalCitationLinks } from "./legal-citation-links";
import { createStatutePath, createStatuteRouteParams } from "./statute-route";

const APP_ORIGIN = "https://app.example.test";
const appOrigins = new Set([APP_ORIGIN]);
const sourceUrl = "https://publisher.example.test/eli/2012/89";
const unsafeScriptUrl = ["javascript", "alert(1)"].join(":");
const id = "019dd47d-f507-7c84-b827-980af11b8980";
const statute = createStatutePath(
  createStatuteRouteParams({
    country: "cze",
    documentId: id,
    eli: "/eli/cz/sb/2012/89",
    slug: "89-2012-sb-obcansky-zakonik",
    version: "2021-01-01",
  }),
);
const decision = createCaseLawDecisionPath(
  createCaseLawDecisionRouteParams({
    country: "cze",
    court: "Nejvyšší soud",
    caseNumber: "26 Cdo 4249/2016",
    decisionId: id,
    slug: null,
    language: null,
    languageAlternates: null,
  }),
);

describe("legal citations prefer a served corpus record", () => {
  for (const [type, path] of [
    ["statute", statute],
    ["statute", `${statute}#par_1729-odst_1`],
    ["decision", decision],
  ] as const) {
    test(`${path} keeps its internal primary, locator and publisher secondary`, () => {
      for (const appUrl of [path, new URL(path, APP_ORIGIN).href]) {
        const result = resolveLegalCitationLinks({
          appUrl,
          sourceUrl,
          appOrigins,
        });
        expect(result.type).toBe(type);
        expect(result.url).toBe(new URL(path, APP_ORIGIN).href);
        expect("source_url" in result ? result.source_url : undefined).toBe(
          sourceUrl,
        );
        expect(
          resolveLegalCitationLinks({
            appUrl: result.url,
            sourceUrl,
            appOrigins,
          }),
        ).toEqual(result);
      }
    });
  }
  test("unheld or unavailable items have only the publisher primary", () => {
    for (const appUrl of [
      null,
      `https://another-app.example.test${statute}`,
      "https://app.example.test/law/cze/statutes",
      unsafeScriptUrl,
    ]) {
      expect(
        resolveLegalCitationLinks({ appUrl, sourceUrl, appOrigins }),
      ).toEqual({ type: "external", url: sourceUrl });
    }
  });
  test("an absent publisher never hides a held record or fabricates a source", () => {
    const held = resolveLegalCitationLinks({
      appUrl: statute,
      sourceUrl: null,
      appOrigins,
    });
    expect(held.type).toBe("statute");
    expect(held.url).toBe(new URL(statute, APP_ORIGIN).href);
    expect(held).not.toHaveProperty("source_url");
    expect(
      resolveLegalCitationLinks({ appUrl: null, sourceUrl: null, appOrigins }),
    ).toEqual({ type: "external", url: null });
  });
  test("unsafe publisher protocols never become a primary or secondary href", () => {
    for (const unsafeSourceUrl of [
      unsafeScriptUrl,
      "data:text/html,unsafe",
      "file:///etc/passwd",
      "not-a-url",
    ]) {
      expect(
        resolveLegalCitationLinks({
          appUrl: null,
          sourceUrl: unsafeSourceUrl,
          appOrigins,
        }),
      ).toEqual({ type: "external", url: null });
      expect(
        resolveLegalCitationLinks({
          appUrl: statute,
          sourceUrl: unsafeSourceUrl,
          appOrigins,
        }),
      ).not.toHaveProperty("source_url");
    }
  });
});
