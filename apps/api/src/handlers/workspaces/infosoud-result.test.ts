import { describe, expect, it } from "bun:test";

import type {
  CaseEvent,
  CaseSearchResultWithHearings,
  HearingEvent,
  RelatedCase,
} from "@stll/infosoud";

import { LIMITS } from "@/api/lib/limits";

import { mapInfoSoudResult } from "./infosoud-result";

const CASE_MARK = {
  bcVec: 64,
  cisloSenatu: 1,
  druhVeci: "T",
  organizace: "OSPHA02",
  rocnik: 2024,
} as const;

const makeCaseEvent = (index: number): CaseEvent => ({
  datum: "10.04.2025",
  jednani: [],
  poradi: index,
  udalost: "TEST",
  udalostId: null,
  znackaId: CASE_MARK,
  zruseno: false,
});

const makeHearing = (index: number): HearingEvent => ({
  bcVec: 64,
  cas: "09:00",
  cislo: index,
  datum: "11.04.2025",
  datumZapisuVysledku: null,
  druh: "T",
  druhJednani: "Jednání",
  jednaciSin: "101",
  jednaniZruseno: false,
  neverejneJednani: false,
  predmetJednani: null,
  resitel: null,
  rocnik: 2024,
  vysledek: null,
});

const makeRelatedCase = (index: number): RelatedCase => ({
  ...CASE_MARK,
  bcVec: index,
});

describe("mapInfoSoudResult", () => {
  it("caps large InfoSoud result arrays before returning them to callers", () => {
    const lookupResult: CaseSearchResultWithHearings = {
      case: {
        bcVec: 64,
        cislo: 1,
        druh: "T",
        nadrizenaOrganizace: "Městský soud v Praze",
        napad: null,
        navazneVeci: Array.from(
          { length: LIMITS.infoSoudRelatedCasesMax + 1 },
          (_, index) => makeRelatedCase(index + 1),
        ),
        organizace: "Obvodní soud Praha 2",
        platneK: null,
        rocnik: 2024,
        stav: "nevyřízená věc",
        stavDatum: "13.12.2024",
        typOrganizace: "os",
        udalosti: Array.from(
          { length: LIMITS.infoSoudEventsMax + 1 },
          (_, index) => makeCaseEvent(index + 1),
        ),
      },
      hearings: {
        bcVec: 64,
        cislo: 1,
        datum: null,
        druh: "T",
        jednaciSin: null,
        nadrizenaOrganizace: "Městský soud v Praze",
        organizace: "Obvodní soud Praha 2",
        platneK: null,
        rocnik: 2024,
        typ: "SPZN",
        udalosti: Array.from(
          { length: LIMITS.infoSoudHearingsMax + 1 },
          (_, index) => makeHearing(index + 1),
        ),
      },
    };

    const result = mapInfoSoudResult({
      lookupResult,
      selectedCourtCode: "OSPHA",
    });

    expect(result.eventCount).toBe(LIMITS.infoSoudEventsMax + 1);
    expect(result.events.length).toBe(LIMITS.infoSoudEventsMax);
    expect(result.eventsTruncated).toBe(true);
    expect(result.hearings.length).toBe(LIMITS.infoSoudHearingsMax);
    expect(result.hearingsTruncated).toBe(true);
    expect(result.relatedCases.length).toBe(LIMITS.infoSoudRelatedCasesMax);
    expect(result.relatedCasesTruncated).toBe(true);
  });
});
