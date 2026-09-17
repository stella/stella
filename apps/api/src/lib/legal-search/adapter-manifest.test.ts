import { describe, expect, test } from "bun:test";

import {
  DECISION_DOCKET_GRAMMARS,
  decisionDocketGrammarForJurisdiction,
} from "@stll/api-contract/decision-docket-grammar";
import { Temporal, parsePlainDate } from "@stll/time";

import {
  CZ_ECLI_COURTS,
  EU_ECLI_COURTS,
  SK_ECLI_COURTS,
} from "@/api/lib/case-law/ecli-court-codes";
import {
  ADAPTER_MANIFESTS,
  decisionDocketGrammarForCountry,
} from "@/api/lib/legal-search/adapter-manifest";
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
      expect(manifest.identifierGrammar).toBe(
        DECISION_DOCKET_GRAMMARS[manifest.country],
      );
      expect(decisionDocketGrammarForCountry(manifest.country)).toBe(
        manifest.identifierGrammar,
      );
      expect(
        decisionDocketGrammarForCountry(manifest.country.toLowerCase()),
      ).toBe(manifest.identifierGrammar);
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
    expect(decisionDocketGrammarForCountry("unknown")).toBeNull();
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

/**
 * Two readers answer "which docket grammar does this jurisdiction use": this
 * module's, keyed off the adapter manifest, and the contract package's, which
 * searches the grammar list. The API is the canonical owner — `search_case_law`
 * and `lookup_case_law` both classify an identifier through it, and a lookup
 * that classified one differently from the search it delegates to would answer
 * `not_found` for a decision the search finds — but the web reads the contract
 * one, so the pair can drift silently. Until they are collapsed into one
 * reader, this binds them: changing either alone fails here.
 */
describe("docket grammar readers agree", () => {
  test("answer alike for every jurisdiction either side declares", () => {
    // The union, so a jurisdiction added to one side alone fails here: a
    // grammar the contract knows and no manifest does leaves the API unable to
    // classify what the web classifies, and the reverse leaves the web unable
    // to classify what the API does.
    const jurisdictions = [
      ...new Set([
        ...Object.values(ADAPTER_MANIFESTS).map(({ country }) => country),
        ...Object.keys(DECISION_DOCKET_GRAMMARS),
      ]),
    ];
    expect(jurisdictions.length).toBeGreaterThan(0);

    for (const jurisdiction of jurisdictions) {
      const fromManifest = decisionDocketGrammarForCountry(jurisdiction);
      const fromContract = decisionDocketGrammarForJurisdiction(jurisdiction);
      expect(fromManifest, `${jurisdiction} has no manifest grammar`).not.toBe(
        null,
      );
      // Deep rather than identity: a grammar copied instead of shared is still
      // correct, and a rule changed on one side is what this has to catch.
      expect(fromContract, `${jurisdiction} has no contract grammar`).toEqual(
        fromManifest,
      );
    }
  });

  test("fold case the same way and decline the same unknown jurisdiction", () => {
    for (const { country } of Object.values(ADAPTER_MANIFESTS)) {
      expect(decisionDocketGrammarForJurisdiction(country.toLowerCase())).toBe(
        decisionDocketGrammarForJurisdiction(country),
      );
    }
    expect(decisionDocketGrammarForCountry("unknown")).toBeNull();
    expect(decisionDocketGrammarForJurisdiction("unknown")).toBeNull();
  });
});
