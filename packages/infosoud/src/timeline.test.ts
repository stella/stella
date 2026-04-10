import { describe, expect, test } from "bun:test";

import {
  enrichCaseEventWithDetail,
  getLatestDecisionCaseEvent,
  getLatestMaterialCaseEvent,
  getNextHearingCaseEvent,
  isMaterialCaseEvent,
} from "./event-details.js";

const createEvent = ({
  date,
  eventType,
  order,
}: {
  readonly date: string;
  readonly eventType: string;
  readonly order: number;
}) => ({
  datum: date,
  jednani: [],
  poradi: order,
  udalost: eventType,
  udalostId: order,
  znackaId: {
    bcVec: 64,
    cisloSenatu: 1,
    druhVeci: "T",
    organizace: "OSSCEDC",
    rocnik: 2024,
  },
  zruseno: false,
});

describe("timeline helpers", () => {
  test("finds the next future hearing from enriched hearing details", () => {
    const pastHearing = enrichCaseEventWithDetail({
      detail: {
        atributy: [
          { hodnota: "Ne", typ: "JED_ZRUS" },
          { hodnota: "10.04.2025 08:30", typ: "JED_D_ZAC" },
        ],
        bcVec: 64,
        cislo: 1,
        datumUdalost: "10.04.2025",
        druh: "T",
        nadrizenaOrganizace: null,
        napad: null,
        navazneVeci: [],
        organizace: "Okresní soud Děčín",
        platneK: null,
        rocnik: 2024,
        stav: null,
        stavDatum: null,
        typOrganizace: "os",
        typUdalosti: "NAR_JED",
      },
      event: createEvent({
        date: "10.04.2025",
        eventType: "NAR_JED",
        order: 1,
      }),
    });
    const nextHearing = enrichCaseEventWithDetail({
      detail: {
        atributy: [
          { hodnota: "Ne", typ: "JED_ZRUS" },
          { hodnota: "20.04.2025 08:30", typ: "JED_D_ZAC" },
        ],
        bcVec: 64,
        cislo: 1,
        datumUdalost: "20.04.2025",
        druh: "T",
        nadrizenaOrganizace: null,
        napad: null,
        navazneVeci: [],
        organizace: "Okresní soud Děčín",
        platneK: null,
        rocnik: 2024,
        stav: null,
        stavDatum: null,
        typOrganizace: "os",
        typUdalosti: "NAR_JED",
      },
      event: createEvent({
        date: "20.04.2025",
        eventType: "NAR_JED",
        order: 2,
      }),
    });

    const result = getNextHearingCaseEvent([pastHearing, nextHearing], {
      now: Date.UTC(2025, 3, 15, 0, 0, 0),
    });

    expect(result?.poradi).toBe(2);
  });

  test("does not treat already-started Czech hearings as upcoming", () => {
    const hearing = enrichCaseEventWithDetail({
      detail: {
        atributy: [
          { hodnota: "Ne", typ: "JED_ZRUS" },
          { hodnota: "15.04.2025 08:30", typ: "JED_D_ZAC" },
        ],
        bcVec: 64,
        cislo: 1,
        datumUdalost: "15.04.2025",
        druh: "T",
        nadrizenaOrganizace: null,
        napad: null,
        navazneVeci: [],
        organizace: "Okresní soud Děčín",
        platneK: null,
        rocnik: 2024,
        stav: null,
        stavDatum: null,
        typOrganizace: "os",
        typUdalosti: "NAR_JED",
      },
      event: createEvent({
        date: "15.04.2025",
        eventType: "NAR_JED",
        order: 1,
      }),
    });

    expect(
      getNextHearingCaseEvent([hearing], {
        now: Date.UTC(2025, 3, 15, 7, 0, 0),
      }),
    ).toBeNull();
  });

  test("finds the latest decision event", () => {
    const earlyDecision = enrichCaseEventWithDetail({
      detail: {
        atributy: [{ hodnota: "15.04.2025", typ: "ROZH_D_VYD" }],
        bcVec: 64,
        cislo: 1,
        datumUdalost: "15.04.2025",
        druh: "T",
        nadrizenaOrganizace: null,
        napad: null,
        navazneVeci: [],
        organizace: "Okresní soud Děčín",
        platneK: null,
        rocnik: 2024,
        stav: null,
        stavDatum: null,
        typOrganizace: "os",
        typUdalosti: "VYD_ROZH",
      },
      event: createEvent({
        date: "15.04.2025",
        eventType: "VYD_ROZH",
        order: 1,
      }),
    });
    const laterDecision = enrichCaseEventWithDetail({
      detail: {
        atributy: [{ hodnota: "25.04.2025", typ: "ROZH_D_VYD" }],
        bcVec: 64,
        cislo: 1,
        datumUdalost: "25.04.2025",
        druh: "T",
        nadrizenaOrganizace: null,
        napad: null,
        navazneVeci: [],
        organizace: "Okresní soud Děčín",
        platneK: null,
        rocnik: 2024,
        stav: null,
        stavDatum: null,
        typOrganizace: "os",
        typUdalosti: "VYD_ROZH",
      },
      event: createEvent({
        date: "25.04.2025",
        eventType: "VYD_ROZH",
        order: 2,
      }),
    });

    expect(
      getLatestDecisionCaseEvent([earlyDecision, laterDecision])?.poradi,
    ).toBe(2);
  });

  test("treats file transfers as non-material for latest material event selection", () => {
    const fileTransfer = createEvent({
      date: "26.04.2025",
      eventType: "ODES_SPIS",
      order: 1,
    });
    const materialStatus = createEvent({
      date: "25.04.2025",
      eventType: "ST_VEC_VYR",
      order: 2,
    });

    expect(isMaterialCaseEvent(fileTransfer)).toBe(false);
    expect(isMaterialCaseEvent(materialStatus)).toBe(true);
    expect(
      getLatestMaterialCaseEvent([fileTransfer, materialStatus])?.poradi,
    ).toBe(2);
  });
});
