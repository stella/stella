import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  CZ_ISIR_ACTION_SKIP,
  CZ_ISIR_DECISION_SCOPE,
  CZ_ISIR_LAST_ID_REQUEST,
  type CzIsirAction,
  czIsirActionsRequest,
  czIsirDecisionAction,
  czIsirDocumentIdOf,
  czIsirDocumentUrl,
  czIsirStruckOffOnPage,
  czIsirStruckOffProceedings,
  readCzIsirActionPage,
  readCzIsirLastId,
} from "@/api/handlers/case-law/ingestion/adapters/cz-isir-feed";
import { CZ_ISIR_INSOLVENCY_COURT_DECISION_EVENTS } from "@/api/handlers/case-law/ingestion/adapters/cz-isir-insolvency-court-events";

const FIXTURE = new URL("__fixtures__/cz-isir-feed-page.xml", import.meta.url);

const fixturePage = async () => {
  const page = readCzIsirActionPage(await Bun.file(FIXTURE).text());
  if (Result.isError(page)) {
    throw page.error;
  }
  return page.value;
};

const envelope = (body: string) =>
  `<?xml version='1.0' encoding='UTF-8'?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${body}</soap:Body></soap:Envelope>`;

describe("readCzIsirActionPage", () => {
  test("reads every action of a page, in order, with its last id", async () => {
    const page = await fixturePage();
    expect(page.actions.map(({ id }) => id)).toEqual([
      65_000_401, 65_000_689, 65_000_700, 65_000_701, 65_000_702, 65_000_703,
      81_000_529, 81_530_300, 81_530_365,
    ]);
    expect(page.lastId).toBe(81_530_365);
  });

  test("keeps the action's coordinates and the note's event fields", async () => {
    const decision = (await fixturePage()).actions.find(
      ({ id }) => id === 65_000_689,
    );
    expect(decision).toEqual({
      id: 65_000_689,
      createdAt: "2024-02-28T13:59:00.000+01:00",
      publishedAt: "2024-02-28T13:59:00.000+01:00",
      documentId: "65350048",
      fileMark: "INS 10782/2023",
      courtCode: "MSPHAAB",
      eventType: 373,
      eventDescription: "Rozhodnutí o odvolání - potvrzeno",
      section: "B",
      sectionNumber: 24,
      note: {
        sideDocument: false,
        sideEvent: false,
        fileState: "KONKURS",
        finalOn: null,
        cancelledAt: null,
        correctedPublicationOn: null,
        struckOffOn: null,
      },
    });
  });

  test("never reads a person, an address or a creditor's name into an action", async () => {
    const read = JSON.stringify(await fixturePage());
    for (const personal of [
      "Vzorová",
      "VZOROVA",
      "Jana",
      "700101",
      "1970-01-01",
      "Vzorov",
      "100 00",
    ]) {
      expect(read).not.toContain(personal);
    }
  });

  test("refuses a page the service failed, a fault, and malformed XML", () => {
    const failed = envelope(
      '<ns2:getIsirWsPublicDataResponse xmlns:ns2="http://isirpublicws.cca.cz/types/"><status><stav>CHYBA</stav><kodChyby>SERVER1</kodChyby></status></ns2:getIsirWsPublicDataResponse>',
    );
    const fault = envelope(
      "<S:Fault><faultcode>S:Client</faultcode><faultstring>bad</faultstring></S:Fault>",
    );
    expect(Result.isError(readCzIsirActionPage(failed))).toBe(true);
    expect(Result.isError(readCzIsirActionPage(fault))).toBe(true);
    expect(Result.isError(readCzIsirActionPage("<data><id>1</id>"))).toBe(true);
    expect(
      Result.isError(
        readCzIsirActionPage('<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>'),
      ),
    ).toBe(true);
  });

  test("reads an empty page at the end of the feed", () => {
    const page = readCzIsirActionPage(
      envelope(
        '<ns2:getIsirWsPublicDataResponse xmlns:ns2="http://isirpublicws.cca.cz/types/"><status><stav>OK</stav></status></ns2:getIsirWsPublicDataResponse>',
      ),
    );
    expect(Result.isOk(page) && page.value).toEqual({
      actions: [],
      lastId: null,
    });
  });
});

describe("czIsirDecisionAction", () => {
  const select = async (
    id: number,
    scope = CZ_ISIR_DECISION_SCOPE.APPELLATE,
  ) => {
    const action = (await fixturePage()).actions.find(
      (candidate) => candidate.id === id,
    );
    if (action === undefined) {
      throw new Error(`no action ${id}`);
    }
    return czIsirDecisionAction(
      action,
      scope,
      CZ_ISIR_INSOLVENCY_COURT_DECISION_EVENTS,
    );
  };

  test("reads a high court's decision with its document", async () => {
    expect(await select(65_000_689)).toEqual({
      type: "decision",
      documentId: "65350048",
    });
    expect(await select(81_000_529)).toEqual({
      type: "decision",
      documentId: "81161847",
    });
  });

  test("skips side documents, final-date updates and every other event", async () => {
    expect(await select(65_000_401)).toEqual({
      type: "skip",
      reason: CZ_ISIR_ACTION_SKIP.SIDE_DOCUMENT,
    });
    expect(await select(65_000_700)).toEqual({
      type: "skip",
      reason: CZ_ISIR_ACTION_SKIP.NO_DOCUMENT,
    });
    for (const id of [65_000_701, 65_000_702, 65_000_703, 81_530_365]) {
      expect(await select(id)).toEqual({
        type: "skip",
        reason: CZ_ISIR_ACTION_SKIP.NOT_A_DECISION,
      });
    }
  });

  test("the insolvency courts' decisions stay out of the appellate scope", () => {
    expect(CZ_ISIR_INSOLVENCY_COURT_DECISION_EVENTS.has(373)).toBe(false);
    expect(CZ_ISIR_INSOLVENCY_COURT_DECISION_EVENTS.has(94)).toBe(true);
  });
});

describe("czIsirStruckOffProceedings", () => {
  test("names each proceeding a page strikes off, by court and file", async () => {
    expect(czIsirStruckOffProceedings((await fixturePage()).actions)).toEqual([
      { courtCode: "KSSCEUL", fileMark: "INS 25896/2020" },
    ]);
  });
});

describe("czIsirStruckOffOnPage", () => {
  const action = (
    id: number,
    eventType: number,
    courtCode: string | null,
    fileMark: string,
  ): CzIsirAction => ({
    id,
    createdAt: null,
    publishedAt: null,
    documentId: null,
    fileMark,
    courtCode,
    eventType,
    eventDescription: null,
    section: null,
    sectionNumber: null,
    note: {
      sideDocument: false,
      sideEvent: false,
      fileState: null,
      finalOn: null,
      cancelledAt: null,
      correctedPublicationOn: null,
      struckOffOn: null,
    },
  });
  const STRIKE_OFF = 636;
  const DECISION = 373;

  test("holds back a decision of a struck-off file by court and file", () => {
    const isStruckOff = czIsirStruckOffOnPage([
      action(1, STRIKE_OFF, "MSPHAAB", "INS 10782/2023"),
    ]);
    expect(isStruckOff(action(2, DECISION, "MSPHAAB", "INS 10782/2023"))).toBe(
      true,
    );
    expect(isStruckOff(action(3, DECISION, "KSSCEUL", "INS 10782/2023"))).toBe(
      false,
    );
  });

  test("holds back a file mark either side states without its court", () => {
    expect(
      czIsirStruckOffOnPage([
        action(1, STRIKE_OFF, "MSPHAAB", "INS 10782/2023"),
      ])(action(2, DECISION, null, "INS 10782/2023")),
    ).toBe(true);
    expect(
      czIsirStruckOffOnPage([action(1, STRIKE_OFF, null, "INS 10782/2023")])(
        action(2, DECISION, "MSPHAAB", "INS 10782/2023"),
      ),
    ).toBe(true);
    expect(
      czIsirStruckOffOnPage([action(1, STRIKE_OFF, null, "INS 1/2023")])(
        action(2, DECISION, "MSPHAAB", "INS 10782/2023"),
      ),
    ).toBe(false);
  });
});

describe("requests and addresses", () => {
  test("asks for the actions after an id, or for the last id", () => {
    expect(czIsirActionsRequest(-1)).toContain("<idPodnetu>-1</idPodnetu>");
    expect(czIsirActionsRequest(81_548_356)).toContain(
      "<typ:getIsirWsPublicIdDataRequest><idPodnetu>81548356</idPodnetu>",
    );
    expect(() => czIsirActionsRequest(-2)).toThrow("Not an ISIR action id");
    expect(() => czIsirActionsRequest(1.5)).toThrow("Not an ISIR action id");
    expect(CZ_ISIR_LAST_ID_REQUEST).toContain(
      "<typ:getIsirWsPublicPosledniIdDataRequest/>",
    );
  });

  test("reads the last id the service published", () => {
    const read = readCzIsirLastId(
      envelope(
        '<ns2:getIsirWsPublicPosledniDataResponse xmlns:ns2="http://isirpublicws.cca.cz/types/"><cisloPosledniId>81548356</cisloPosledniId><status><stav>OK</stav></status></ns2:getIsirWsPublicPosledniDataResponse>',
      ),
    );
    expect(Result.isOk(read) && read.value).toBe(81_548_356);
  });

  test("a document address is the servlet's, by a numeric id only", () => {
    expect(
      czIsirDocumentIdOf(
        "http://as007.cca.cz:8080/isir_public_ws/doc/Document?idDokument=66142",
      ),
    ).toBe("66142");
    expect(czIsirDocumentIdOf("https://isir.justice.cz/x?idDokument=1;2")).toBe(
      null,
    );
    expect(czIsirDocumentUrl("65350048")).toBe(
      "https://isir.justice.cz:8443/isir_public_ws/doc/Document?idDokument=65350048",
    );
    expect(() => czIsirDocumentUrl("../x")).toThrow("Not an ISIR document id");
  });
});
