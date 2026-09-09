import { describe, expect, test } from "bun:test";

import { Temporal, parsePlainDate } from "@stll/time";

import {
  CZ_ECLI_COURTS,
  EU_ECLI_COURTS,
  SK_ECLI_COURTS,
} from "@/api/lib/case-law/ecli-court-codes";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";

describe("case-law adapter manifests", () => {
  test("cover every adapter key exactly once", () => {
    const declared = Object.values(ADAPTER_MANIFESTS)
      .map(({ key }) => key)
      .toSorted();
    expect(declared).toEqual(Object.values(ADAPTER_KEYS).toSorted());
  });

  test("carry valid bounded source facts", () => {
    for (const manifest of Object.values(ADAPTER_MANIFESTS)) {
      expect(manifest.name.trim().length).toBeGreaterThan(0);
      expect(Number.isSafeInteger(manifest.duplicateTextThreshold)).toBe(true);
      expect(manifest.duplicateTextThreshold).toBeGreaterThan(0);

      const from = parsePlainDate(manifest.dateRange.fromInclusive);
      expect(from).not.toBeNull();
      if (from === null) {
        continue;
      }

      switch (manifest.dateRange.through.type) {
        case "open":
          break;
        case "inclusive": {
          const through = parsePlainDate(manifest.dateRange.through.date);
          expect(through).not.toBeNull();
          if (through !== null) {
            expect(
              Temporal.PlainDate.compare(through, from),
            ).toBeGreaterThanOrEqual(0);
          }
          break;
        }
        default: {
          manifest.dateRange.through satisfies never;
        }
      }

      const placeholderTexts = manifest.placeholderPatterns.map(
        ({ type, text }) => {
          expect(type).toBe("exact");
          expect(text.trim()).toBe(text);
          expect(text.length).toBeGreaterThan(0);
          return text;
        },
      );
      expect(new Set(placeholderTexts).size).toBe(placeholderTexts.length);

      for (const [code, court] of Object.entries(manifest.ecliCourtCodes)) {
        expect(code).toMatch(/^[A-Z0-9]{1,8}$/u);
        expect(court.trim()).toBe(court);
        expect(court.length).toBeGreaterThan(0);
      }
    }
  });

  test("share each jurisdiction's declared ECLI table", () => {
    expect(ADAPTER_MANIFESTS[ADAPTER_KEYS.CZ_REGIONAL].ecliCourtCodes).toBe(
      CZ_ECLI_COURTS,
    );
    expect(ADAPTER_MANIFESTS[ADAPTER_KEYS.CZ_NS].ecliCourtCodes).toBe(
      CZ_ECLI_COURTS,
    );
    expect(ADAPTER_MANIFESTS[ADAPTER_KEYS.CZ_NSS].ecliCourtCodes).toBe(
      CZ_ECLI_COURTS,
    );
    expect(ADAPTER_MANIFESTS[ADAPTER_KEYS.CZ_US].ecliCourtCodes).toBe(
      CZ_ECLI_COURTS,
    );
    expect(ADAPTER_MANIFESTS[ADAPTER_KEYS.SK_COURTS].ecliCourtCodes).toBe(
      SK_ECLI_COURTS,
    );
    expect(ADAPTER_MANIFESTS[ADAPTER_KEYS.SK_US].ecliCourtCodes).toBe(
      SK_ECLI_COURTS,
    );
    expect(ADAPTER_MANIFESTS[ADAPTER_KEYS.EU_ECJ].ecliCourtCodes).toBe(
      EU_ECLI_COURTS,
    );
  });
});
