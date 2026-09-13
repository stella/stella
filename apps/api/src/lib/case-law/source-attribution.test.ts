import { describe, expect, test } from "bun:test";

import { decisionSourceAttributionUrl } from "@/api/lib/case-law/source-attribution";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";

describe("decisionSourceAttributionUrl", () => {
  test("attributes a decision to its own source page", () => {
    expect(
      decisionSourceAttributionUrl({
        adapterKey: ADAPTER_KEYS.CZ_NS,
        sourceUrl: "https://rozhodnuti.nsoud.cz/detail/123",
      }),
    ).toBe("https://rozhodnuti.nsoud.cz/detail/123");
  });

  test("falls back to the publisher's landing page without one", () => {
    expect(
      decisionSourceAttributionUrl({
        adapterKey: ADAPTER_KEYS.CZ_NS,
        sourceUrl: null,
      }),
    ).toBe(ADAPTER_MANIFESTS[ADAPTER_KEYS.CZ_NS].publicHomeUrl);
  });

  test.each([
    ["empty", ""],
    ["blank", "   "],
    ["not a URL", "detail/123"],
    ["not browsable", "ftp://example.test/decision.pdf"],
  ])("falls back when the stored source page is %s", (_label, sourceUrl) => {
    expect(
      decisionSourceAttributionUrl({
        adapterKey: ADAPTER_KEYS.SK_US,
        sourceUrl,
      }),
    ).toBe(ADAPTER_MANIFESTS[ADAPTER_KEYS.SK_US].publicHomeUrl);
  });

  // A source row outlives the adapter that wrote it, so the miss has to be
  // reported rather than answered with some other publisher's page.
  test("has no attribution for a retired adapter key", () => {
    expect(
      decisionSourceAttributionUrl({
        adapterKey: "cz-retired",
        sourceUrl: null,
      }),
    ).toBeNull();
  });

  test("every registered source resolves to a browsable attribution", () => {
    const unattributed = Object.values(ADAPTER_KEYS).filter(
      (adapterKey) =>
        decisionSourceAttributionUrl({ adapterKey, sourceUrl: null }) === null,
    );

    expect(unattributed).toEqual([]);
  });

  test("every declared landing page is an https URL", () => {
    const notHttps = Object.values(ADAPTER_MANIFESTS)
      .filter(
        ({ publicHomeUrl }) =>
          !URL.canParse(publicHomeUrl) ||
          new URL(publicHomeUrl).protocol !== "https:",
      )
      .map(({ key }) => key);

    expect(notHttps).toEqual([]);
  });
});
