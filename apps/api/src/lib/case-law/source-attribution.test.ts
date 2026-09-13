import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { decisionSourceAttributionUrl } from "@/api/lib/case-law/source-attribution";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";

const isHttpsUrl = (value: string): boolean =>
  URL.canParse(value) && new URL(value).protocol === "https:";

let analytics: RecordingAnalytics;

beforeEach(() => {
  analytics = installRecordingAnalytics();
});

afterEach(() => {
  analytics.restore();
});

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

  test("every registered source resolves to an https landing page", () => {
    const unattributed = Object.values(ADAPTER_KEYS).filter((adapterKey) => {
      const url = decisionSourceAttributionUrl({ adapterKey, sourceUrl: null });
      return url === null || !isHttpsUrl(url);
    });

    expect(unattributed).toEqual([]);
  });

  // A key the manifest map does not hold costs the decision its attribution
  // line, so the miss is reported rather than rendered around: the row and the
  // registry have drifted, and nothing downstream can tell from a null.
  test("reports a source that names an unregistered adapter key", () => {
    expect(
      decisionSourceAttributionUrl({
        adapterKey: "cz-unregistered",
        sourceUrl: null,
      }),
    ).toBeNull();

    expect(
      analytics.exceptions().map((event) => event.properties),
    ).toMatchObject([
      {
        "error.class": "DatabaseError",
        source: "case-law-source-attribution",
        adapterKey: "cz-unregistered",
      },
    ]);
  });

  test("reports nothing when the manifest answers", () => {
    decisionSourceAttributionUrl({
      adapterKey: ADAPTER_KEYS.CZ_NS,
      sourceUrl: null,
    });

    expect(analytics.exceptions()).toEqual([]);
  });
});
