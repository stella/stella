import { describe, expect, test } from "bun:test";

import { getLabeledEventAttributes } from "./codes.js";
import {
  decodeEventDetail,
  enrichCaseEventWithDetail,
  getAppealDispositionEventDetailSummary,
  getAppealSubmissionEventDetailSummary,
  getCaseTransferEventDetailSummary,
  getDecisionEventDetailSummary,
  getEventAttribute,
  getEventAttributeMap,
  getFileTransferEventDetailSummary,
  getHearingEventDetailSummary,
  getStatusEventDetailSummary,
} from "./event-details.js";

const createDetail = ({
  attributes,
  organizationType = "os",
  type,
}: {
  readonly attributes: { hodnota: string; typ: string }[];
  readonly organizationType?: string | undefined;
  readonly type: string;
}) => ({
  atributy: attributes,
  bcVec: 64,
  cislo: 1,
  datumUdalost: "15.04.2025",
  druh: "T",
  nadrizenaOrganizace: "Krajský soud Ústí nad Labem",
  napad: null,
  navazneVeci: [],
  organizace: "Okresní soud Děčín",
  platneK: null,
  rocnik: 2024,
  stav: "nevyřízená věc",
  stavDatum: "13.12.2024",
  typOrganizace: organizationType,
  typUdalosti: type,
});

describe("event detail helpers", () => {
  const hearingDetail = createDetail({
    attributes: [
      { hodnota: "Ano", typ: "JED_ZRUS" },
      { hodnota: "Veřejné zasedání", typ: "JED_DRUH" },
      { hodnota: "Odročeno", typ: "JED_VYSLED" },
      { hodnota: "16.04.2025", typ: "JED_D_Z_V" },
      { hodnota: "101", typ: "JED_SIN" },
      { hodnota: "15.04.2025 08:30", typ: "JED_D_ZAC" },
    ],
    type: "NAR_JED",
  });

  test("builds an attribute map and reads individual attributes", () => {
    expect(getEventAttributeMap(hearingDetail)).toEqual({
      JED_D_ZAC: "15.04.2025 08:30",
      JED_D_Z_V: "16.04.2025",
      JED_DRUH: "Veřejné zasedání",
      JED_SIN: "101",
      JED_VYSLED: "Odročeno",
      JED_ZRUS: "Ano",
    });
    expect(getEventAttribute(hearingDetail, "JED_SIN")).toBe("101");
    expect(getEventAttribute(hearingDetail, "NEEXISTUJE")).toBeNull();
  });

  test("extracts hearing detail with parsed temporal values", () => {
    expect(getHearingEventDetailSummary(hearingDetail)).toEqual({
      cancelled: true,
      hearingType: "Veřejné zasedání",
      result: "Odročeno",
      resultRecordedOn: "16.04.2025",
      resultRecordedOnDate: {
        isoDate: "2025-04-16",
        raw: "16.04.2025",
        unixMs: Date.UTC(2025, 3, 16),
      },
      room: "101",
      startsAt: "15.04.2025 08:30",
      startsAtDateTime: {
        isoDateTime: "2025-04-15T08:30:00",
        raw: "15.04.2025 08:30",
        unixMs: Date.UTC(2025, 3, 15, 6, 30, 0),
      },
    });
  });

  test("adds human labels and known flags to detail attributes", () => {
    expect(getLabeledEventAttributes(hearingDetail)).toEqual([
      {
        hodnota: "Ano",
        known: true,
        label: "Jednání zrušeno",
        typ: "JED_ZRUS",
      },
      {
        hodnota: "Veřejné zasedání",
        known: true,
        label: "Druh jednání",
        typ: "JED_DRUH",
      },
      {
        hodnota: "Odročeno",
        known: true,
        label: "Výsledek",
        typ: "JED_VYSLED",
      },
      {
        hodnota: "16.04.2025",
        known: true,
        label: "Datum zápisu výsledku",
        typ: "JED_D_Z_V",
      },
      {
        hodnota: "101",
        known: true,
        label: "Jednací síň",
        typ: "JED_SIN",
      },
      {
        hodnota: "15.04.2025 08:30",
        known: true,
        label: "Začátek jednání",
        typ: "JED_D_ZAC",
      },
    ]);
  });

  test("decodes hearing events with metadata and no unknown attributes", () => {
    expect(decodeEventDetail(hearingDetail)).toMatchObject({
      eventType: "NAR_JED",
      kind: "hearing",
      metadata: {
        description: "Bylo nařízeno jednání ve věci",
        known: true,
        label: "Nařízení jednání",
      },
      unknownAttributeTypes: [],
    });
  });

  test("decodes decision events", () => {
    const detail = createDetail({
      attributes: [
        { hodnota: "Usnesení", typ: "ROZH_DR_RO" },
        { hodnota: "Odvolací soud", typ: "ROZH_DR_S" },
        { hodnota: "14.04.2025", typ: "ROZH_D_DIK" },
        { hodnota: "15.04.2025", typ: "ROZH_D_VYD" },
        { hodnota: "16.04.2025", typ: "ROZH_D_VYP" },
        { hodnota: "20.04.2025", typ: "ROZH_D_PM" },
        { hodnota: "Ne", typ: "ROZH_ZRUS" },
        { hodnota: "Ano", typ: "ROZH_KON" },
        { hodnota: "Potvrzeno", typ: "ROZH_VYS" },
      ],
      type: "VYD_ROZH",
    });

    expect(getDecisionEventDetailSummary(detail)).toMatchObject({
      cancelled: false,
      decisionType: "Usnesení",
      disposesCase: true,
      result: "Potvrzeno",
    });
    expect(decodeEventDetail(detail)).toMatchObject({
      decision: {
        finalOn: { isoDate: "2025-04-20" },
        issuedOn: { isoDate: "2025-04-15" },
      },
      kind: "decision",
    });
  });

  test("decodes appeal submission events", () => {
    const detail = createDetail({
      attributes: [
        { hodnota: "Odvolání", typ: "OP_DRUH" },
        { hodnota: "10.02.2025", typ: "OP_D_DOSO" },
        { hodnota: "11.02.2025", typ: "OP_D_DOSLO" },
        { hodnota: "15.02.2025", typ: "OP_D_P2" },
        { hodnota: "Usnesení", typ: "OP_D_ROZH" },
        { hodnota: "01.02.2025", typ: "OP_D_VYD" },
        { hodnota: "Okresní soud Děčín", typ: "OP_ROZ_PR" },
      ],
      type: "POD_OP_PR",
    });

    expect(getAppealSubmissionEventDetailSummary(detail)).toMatchObject({
      againstDecisionType: "Usnesení",
      filedOn: { isoDate: "2025-02-10" },
      remedyType: "Odvolání",
      submittedToCourtOn: { isoDate: "2025-02-11" },
    });
    expect(decodeEventDetail(detail)).toMatchObject({
      appealSubmission: {
        forwardedToSecondLevelOn: { isoDate: "2025-02-15" },
      },
      kind: "appeal_submission",
    });
  });

  test("treats ks-only OP_D_PODA values as court delivery, not postal filing", () => {
    const detail = createDetail({
      attributes: [
        { hodnota: "Odvolání", typ: "OP_DRUH" },
        { hodnota: "10.02.2025", typ: "OP_D_PODA" },
      ],
      organizationType: "ks",
      type: "POD_OP_PR",
    });

    expect(getAppealSubmissionEventDetailSummary(detail)).toMatchObject({
      filedOn: { isoDate: "2025-02-10" },
      submittedAtPostOn: { isoDate: null },
      submittedToCourtOn: { isoDate: "2025-02-10" },
    });
  });

  test("decodes appeal disposition events", () => {
    const detail = createDetail({
      attributes: [
        { hodnota: "Odvolání", typ: "OP_ROZ_O_O" },
        { hodnota: "20.03.2025", typ: "OP_D_VYD_O" },
        { hodnota: "21.03.2025", typ: "OP_D_VYR" },
        { hodnota: "21.03.2025", typ: "OP_V_2ST" },
        { hodnota: "Usnesení", typ: "OP_DR_ROZH" },
        { hodnota: "Zamítnuto", typ: "OP_VYSL" },
      ],
      type: "VYR_OP_PR",
    });

    expect(getAppealDispositionEventDetailSummary(detail)).toMatchObject({
      resolutionType: "Usnesení",
      resolvedOn: { isoDate: "2025-03-21" },
      result: "Zamítnuto",
    });
    expect(decodeEventDetail(detail)).toMatchObject({
      appealDisposition: {
        resolutionDecisionIssuedOn: { isoDate: "2025-03-20" },
      },
      kind: "appeal_disposition",
    });
  });

  test("decodes file transfer, case transfer, and status events", () => {
    const fileTransferDetail = createDetail({
      attributes: [
        { hodnota: "15.04.2025", typ: "OD_SP_D_OD" },
        { hodnota: "20.04.2025", typ: "OD_SP_D_OV" },
        { hodnota: "Ministerstvo spravedlnosti", typ: "OD_SP_KOMU" },
        { hodnota: "Nahlédnutí", typ: "OD_SP_UCEL" },
      ],
      type: "ODES_SPIS",
    });
    const caseTransferDetail = createDetail({
      attributes: [
        { hodnota: "18.04.2025", typ: "PREVD_D_OD" },
        { hodnota: "Krajský soud Ústí nad Labem", typ: "PREVD_SOUD" },
        { hodnota: "6 To 436/2025", typ: "PREVD_SPZN" },
      ],
      type: "PREVD_SPIS",
    });
    const statusDetail = createDetail({
      attributes: [
        { hodnota: "Vyřízená věc", typ: "STAV_VECI" },
        { hodnota: "22.04.2025", typ: "ST_VEC_D_D" },
        { hodnota: "Pravomocně skončeno", typ: "ST_VEC_UPR" },
        { hodnota: "Rozsudek", typ: "ST_VEC_ZVR" },
      ],
      type: "ST_VEC_VYR",
    });

    expect(getFileTransferEventDetailSummary(fileTransferDetail)).toMatchObject(
      {
        purpose: "Nahlédnutí",
        recipient: "Ministerstvo spravedlnosti",
        sentOn: { isoDate: "2025-04-15" },
      },
    );
    expect(getCaseTransferEventDetailSummary(caseTransferDetail)).toMatchObject(
      {
        destinationCaseMark: "6 To 436/2025",
        destinationCourt: "Krajský soud Ústí nad Labem",
      },
    );
    expect(getStatusEventDetailSummary(statusDetail)).toMatchObject({
      detail: "Pravomocně skončeno",
      resolution: "Rozsudek",
      status: "Vyřízená věc",
    });
    expect(decodeEventDetail(fileTransferDetail)).toMatchObject({
      kind: "file_transfer",
    });
    expect(decodeEventDetail(caseTransferDetail)).toMatchObject({
      kind: "case_transfer",
    });
    expect(decodeEventDetail(statusDetail)).toMatchObject({
      kind: "status",
    });
  });

  test("marks unknown event families and unknown attribute codes explicitly", () => {
    const detail = createDetail({
      attributes: [
        { hodnota: "něco", typ: "X_NEZNAMY" },
        { hodnota: "test", typ: "JED_SIN" },
      ],
      type: "NEZNAMA_UDALOST",
    });

    expect(decodeEventDetail(detail)).toMatchObject({
      kind: "unknown",
      metadata: {
        known: false,
        label: null,
      },
      unknownAttributeTypes: ["X_NEZNAMY"],
    });
  });

  test("enriches a case event with decoded detail metadata", () => {
    const enriched = enrichCaseEventWithDetail({
      detail: hearingDetail,
      event: {
        datum: "15.04.2025",
        jednani: [],
        poradi: 1,
        udalost: "NAR_JED",
        udalostId: 1001,
        znackaId: {
          bcVec: 64,
          cisloSenatu: 1,
          druhVeci: "T",
          organizace: "OSSCEDC",
          rocnik: 2024,
        },
        zruseno: false,
      },
    });

    expect(enriched).toMatchObject({
      decodedDetail: {
        kind: "hearing",
      },
      detail: hearingDetail,
      detailAttributes: {
        JED_SIN: "101",
      },
      detailTypeDescription: "Bylo nařízeno jednání ve věci",
      detailTypeKnown: true,
      detailTypeLabel: "Nařízení jednání",
      hearingDetail: {
        cancelled: true,
        room: "101",
      },
      udalost: "NAR_JED",
    });

    expect(enriched.detailAttributeEntries).toContainEqual({
      hodnota: "Ano",
      known: true,
      label: "Jednání zrušeno",
      typ: "JED_ZRUS",
    });
  });
});
