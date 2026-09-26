import { afterEach, describe, expect, test } from "bun:test";

import type { EntityCheckSubject } from "./result.js";
import { runEntityCheck } from "./run.js";

// Fixtures are live ISIR_CUZK_WS responses captured on 2026-09-26:
//   isir-company-found*.xml   IČO 26863154, a company in reorganisation
//   isir-company-clear.xml    IČO 45274649, no proceedings (WS2)
//   isir-person-clear.xml     a fictitious name and birth date (WS2)
//   isir-invalid-combination  a first name without a surname (WS1)
//   isir-soap-fault.xml       an out-of-range relevance cap (HTTP 500)
//   isir-outage-page.html     the register's "system unavailable" page
// and live ADIS rozhraniCRPDPH responses captured the same day:
//   adis-vat-payer-clear.xml   DIČ CZ45274649, a reliable VAT payer
//   adis-unreliable-payer.xml  DIČ CZ00121100, a published unreliable payer
//   adis-not-found.xml         a DIČ the VAT register does not hold

const FIXTURE_DIR = new URL("__fixtures__/", import.meta.url);
const fixture = async (name: string): Promise<string> =>
  await Bun.file(new URL(name, FIXTURE_DIR)).text();

type Reply = { body: string; status?: number; contentType?: string };
type RecordedRequest = { url: string; body: string; soapAction: string | null };

let restoreFetch: () => void = () => {
  // replaced by stubFetch
};

afterEach(() => {
  restoreFetch();
});

/** Answer each request in turn; record what was sent. */
const stubFetch = (replies: readonly (Reply | Error)[]): RecordedRequest[] => {
  const requests: RecordedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: URL | Request | string, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push({
        url,
        body: typeof init?.body === "string" ? init.body : "",
        soapAction: new Headers(init?.headers).get("SOAPAction"),
      });
      const reply = replies.at(requests.length - 1);
      if (reply === undefined) {
        throw new Error(`Unexpected request #${requests.length}`);
      }
      if (reply instanceof Error) {
        throw reply;
      }
      return new Response(reply.body, {
        status: reply.status ?? 200,
        headers: {
          "Content-Type": reply.contentType ?? "text/xml;charset=UTF-8",
        },
      });
    },
    { preconnect: original.preconnect },
  );
  restoreFetch = () => {
    globalThis.fetch = original;
  };
  return requests;
};

const INSOLVENT_COMPANY: EntityCheckSubject = {
  type: "company-id",
  value: "26863154",
};
const HEALTHY_COMPANY: EntityCheckSubject = {
  type: "company-id",
  value: "45274649",
};

const soapBody = (inner: string): string =>
  `<?xml version='1.0' encoding='UTF-8'?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns2:getIsirWsCuzkDataResponse xmlns:ns2="http://isirws.cca.cz/types/">${inner}</ns2:getIsirWsCuzkDataResponse></soap:Body></soap:Envelope>`;

const errorCodeBody = (code: string): string =>
  soapBody(`<stav><kodChyby>${code}</kodChyby><textChyby>x</textChyby></stav>`);

/** Run a check that must produce an outcome rather than an error. */
const check = async (options: Parameters<typeof runEntityCheck>[0]) =>
  (await runEntityCheck(options)).unwrap();

describe("Czech insolvency check", () => {
  test("reports a company in reorganisation as found, with its pending proceeding", async () => {
    const found = await fixture("isir-company-found.xml");
    const pending = await fixture("isir-company-found-pending.xml");
    const requests = stubFetch([{ body: found }, { body: pending }]);

    const result = await check({
      kind: "cz-insolvency",
      subject: INSOLVENT_COMPANY,
    });

    expect(result.status).toBe("found");
    if (result.status !== "found") {
      return;
    }
    expect(result.sourceDataAsOf).toBe("2026-09-26T15:26:35.000Z");
    expect(result.totalMatches).toBe(1);
    expect(result.findings).toEqual([
      {
        fileNumber: "25 INS 10525/2016",
        court: "Krajský soud v Ostravě",
        phase: "ongoing",
        stateCode: "REORGANIZ",
        matchedBy: "company-id",
        debtor: {
          name: "Správa pohledávek OKD, a.s.",
          firstName: null,
          companyId: "26863154",
          birthDate: null,
          address: "Stonavská 2179, 735 06 Karviná",
        },
        insolvencyDeclaredOn: "2016-05-09",
        insolvencyEndedOn: null,
        url: "https://isir.justice.cz/isir/ueu/evidence_upadcu_detail.do?id=3BD92F3EAA724B37ACCEDD86B31BE055",
      },
    ]);
    // The first query covers every proceeding and caps matching at the IČO;
    // only the second one narrows to pending proceedings.
    expect(requests).toHaveLength(2);
    expect(requests[0]?.body).toContain("<ic>26863154</ic>");
    expect(requests[0]?.body).toContain(
      "<maxRelevanceVysledku>2</maxRelevanceVysledku>",
    );
    expect(requests[0]?.body).not.toContain("filtrAktualniRizeni");
    expect(requests[1]?.body).toContain(
      "<filtrAktualniRizeni>T</filtrAktualniRizeni>",
    );
  });

  test("marks a proceeding ended when the pending-only query finds nothing", async () => {
    stubFetch([
      { body: await fixture("isir-company-found.xml") },
      { body: await fixture("isir-company-clear.xml") },
    ]);
    const result = await check({
      kind: "cz-insolvency",
      subject: INSOLVENT_COMPANY,
    });
    expect(result.status === "found" && result.findings[0].phase).toBe("ended");
  });

  test("keeps the findings when the pending-only query fails", async () => {
    stubFetch([
      { body: await fixture("isir-company-found.xml") },
      {
        body: await fixture("isir-outage-page.html"),
        contentType: "text/html",
      },
    ]);
    const result = await check({
      kind: "cz-insolvency",
      subject: INSOLVENT_COMPANY,
    });
    expect(result.status === "found" && result.findings[0].phase).toBe(
      "unverified",
    );
  });

  test("reports a company without proceedings as clear after one query", async () => {
    const requests = stubFetch([
      { body: await fixture("isir-company-clear.xml") },
    ]);
    const result = await check({
      kind: "cz-insolvency",
      subject: HEALTHY_COMPANY,
    });
    expect(result).toMatchObject({
      status: "clear",
      kind: "cz-insolvency",
      subject: HEALTHY_COMPANY,
      sourceDataAsOf: null,
    });
    expect(requests).toHaveLength(1);
  });

  test("queries a person by surname, first name and birth date only", async () => {
    const requests = stubFetch([
      { body: await fixture("isir-person-clear.xml") },
    ]);
    const result = await check({
      kind: "cz-insolvency",
      subject: {
        type: "person",
        firstName: " Testovaná ",
        lastName: "Zkušební<ková>",
        birthDate: "1901-01-01",
      },
    });
    expect(result.status).toBe("clear");
    const body = requests[0]?.body ?? "";
    expect(body).toContain("<nazevOsoby>Zkušební&lt;ková&gt;</nazevOsoby>");
    expect(body).toContain("<jmeno>Testovaná</jmeno>");
    expect(body).toContain("<datumNarozeni>1901-01-01</datumNarozeni>");
    expect(body).toContain("<maxRelevanceVysledku>4</maxRelevanceVysledku>");
  });
});

describe("Czech insolvency check never reports clear without an explicit empty answer", () => {
  const failures: readonly {
    name: string;
    reply: () => Promise<Reply | Error>;
    reason: string;
    detail?: string | null;
  }[] = [
    {
      name: "the outage page served with HTTP 200",
      reply: async () => ({
        body: await fixture("isir-outage-page.html"),
        contentType: "text/html",
      }),
      reason: "outage-page",
    },
    {
      name: "the outage page with an XML content type",
      reply: async () => ({ body: await fixture("isir-outage-page.html") }),
      reason: "outage-page",
    },
    {
      name: "a SOAP fault",
      reply: async () => ({
        body: await fixture("isir-soap-fault.xml"),
        status: 500,
      }),
      reason: "soap-fault",
      detail: "soap:Client",
    },
    {
      name: "a rejected parameter combination (WS1)",
      reply: async () => ({
        body: await fixture("isir-invalid-combination.xml"),
      }),
      reason: "source-error",
      detail: "WS1",
    },
    ...["WS3", "WS4", "SQL1", "SERVER1", "WS9"].map((code) => ({
      name: `error code ${code}`,
      reply: async () => ({ body: errorCodeBody(code) }),
      reason: "source-error",
      detail: code,
    })),
    {
      name: "an empty body",
      reply: async () => ({ body: "" }),
      reason: "malformed-response",
    },
    {
      name: "a JSON body",
      reply: async () => ({ body: '{"stav":"WS2"}' }),
      reason: "malformed-response",
    },
    {
      name: "a status without a code or records",
      reply: async () => ({
        body: soapBody("<stav><pocetVysledku>0</pocetVysledku></stav>"),
      }),
      reason: "malformed-response",
    },
    {
      name: "a response without a status",
      reply: async () => ({ body: soapBody("") }),
      reason: "malformed-response",
    },
    {
      name: "records matched on a bare surname",
      reply: async () => ({
        body: (await fixture("isir-company-found.xml")).replace(
          "<relevanceVysledku>2</relevanceVysledku>",
          "<relevanceVysledku>7</relevanceVysledku>",
        ),
      }),
      reason: "malformed-response",
    },
    {
      name: "an empty-result code alongside records",
      reply: async () => ({
        body: (await fixture("isir-company-found.xml")).replace(
          "<pocetVysledku>1</pocetVysledku>",
          "<kodChyby>WS2</kodChyby><pocetVysledku>1</pocetVysledku>",
        ),
      }),
      reason: "malformed-response",
    },
    {
      name: "an empty-result answer with HTTP 503",
      reply: async () => ({
        body: await fixture("isir-company-clear.xml"),
        status: 503,
      }),
      reason: "http-error",
      detail: "503",
    },
    {
      name: "a transport failure",
      reply: async () => new TypeError("fetch failed"),
      reason: "network",
    },
    {
      name: "a timeout",
      reply: async () =>
        new DOMException("The operation timed out.", "TimeoutError"),
      reason: "timeout",
    },
  ];

  for (const failure of failures) {
    test(`${failure.name} is unavailable`, async () => {
      stubFetch([await failure.reply()]);
      const result = await check({
        kind: "cz-insolvency",
        subject: HEALTHY_COMPANY,
      });
      expect(result.status).toBe("unavailable");
      expect(result.status === "unavailable" && result.reason).toBe(
        failure.reason,
      );
      if (failure.detail !== undefined) {
        expect(result.status === "unavailable" && result.detail).toBe(
          failure.detail,
        );
      }
    });
  }

  test("no truncation of an empty or a found answer reads as clear", async () => {
    for (const name of ["isir-company-clear.xml", "isir-company-found.xml"]) {
      const complete = await fixture(name);
      for (let length = 0; length < complete.length; length += 1) {
        const truncated = complete.slice(0, length);
        stubFetch([{ body: truncated }, { body: truncated }]);
        const result = await check({
          kind: "cz-insolvency",
          subject: HEALTHY_COMPANY,
        });
        restoreFetch();
        if (result.status === "clear") {
          throw new Error(
            `${name} truncated to ${length} characters read as clear`,
          );
        }
      }
    }
  });
});

describe("Czech insolvency check input", () => {
  test("answers not-covered for a tax ID without querying", async () => {
    const requests = stubFetch([]);
    const result = await check({
      kind: "cz-insolvency",
      subject: { type: "tax-id", value: "CZ45274649" },
    });
    expect(result).toMatchObject({
      status: "not-covered",
      supportedSubjectTypes: ["company-id", "person"],
    });
    expect(requests).toHaveLength(0);
  });

  test("rejects a malformed subject before any request", async () => {
    const requests = stubFetch([]);
    const invalid: readonly EntityCheckSubject[] = [
      { type: "company-id", value: "26863155" },
      {
        type: "person",
        firstName: "J",
        lastName: "Novák",
        birthDate: "1980-01-01",
      },
      {
        type: "person",
        firstName: "Jan",
        lastName: "Novák",
        birthDate: "1980-02-30",
      },
      {
        type: "person",
        firstName: "Jan",
        lastName: "Novák",
        birthDate: "01.02.1980",
      },
      {
        type: "person",
        firstName: "Jan",
        lastName: "Novák",
        birthDate: "2999-01-01",
      },
    ];
    for (const subject of invalid) {
      const result = await runEntityCheck({ kind: "cz-insolvency", subject });
      expect(result.isErr() && result.error._tag).toBe("EntityCheckInputError");
    }
    expect(requests).toHaveLength(0);
  });

  test("reports caller cancellation as an error, not an outcome", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller went away"));
    stubFetch([new DOMException("aborted", "AbortError")]);
    const result = await runEntityCheck({
      kind: "cz-insolvency",
      subject: HEALTHY_COMPANY,
      signal: controller.signal,
    });
    expect(result.isErr() && result.error._tag).toBe(
      "EntityCheckCancelledError",
    );
  });
});

const adisBody = (inner: string): string =>
  `<?xml version="1.0" encoding="utf-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><StatusNespolehlivySubjektRozsirenyResponse xmlns="http://adis.mfcr.cz/rozhraniCRPDPH/">${inner}</StatusNespolehlivySubjektRozsirenyResponse></soapenv:Body></soapenv:Envelope>`;

const ADIS_OK =
  '<status odpovedGenerovana="2026-09-26" statusCode="0" statusText="OK"/>';

describe("Czech VAT reliability check", () => {
  test("reads a reliable payer as clear, with its published accounts", async () => {
    const requests = stubFetch([
      { body: await fixture("adis-vat-payer-clear.xml") },
    ]);
    const result = await check({
      kind: "cz-vat-reliability",
      subject: { type: "tax-id", value: "CZ 452 74 649" },
    });

    expect(result.status).toBe("clear");
    if (result.status !== "clear" || result.kind !== "cz-vat-reliability") {
      return;
    }
    expect(result.subject).toEqual({
      type: "tax-id",
      value: "CZ45274649",
      derivedFrom: null,
    });
    expect(result.record).toMatchObject({
      subjectType: "vat-payer",
      name: "ČEZ, A. S.",
      address:
        "Duhová 1444/2, MICHLE (PRAHA 4), 14000 PRAHA 4, Česká republika",
      taxOfficeCode: "13",
    });
    expect(result.record.publishedAccounts).toHaveLength(17);
    expect(result.record.publishedAccounts).toContainEqual({
      account: "27-5868650297/0100",
      publishedOn: "2013-04-01",
      withdrawnOn: null,
    });
    expect(result.record.publishedAccounts).toContainEqual({
      account: "CZ6426000000002001268200",
      publishedOn: "2013-04-01",
      withdrawnOn: null,
    });
    expect(requests[0]?.body).toContain("<roz:dic>45274649</roz:dic>");
    expect(requests[0]?.soapAction).toBe(
      '"http://adis.mfcr.cz/rozhraniCRPDPH/getStatusNespolehlivySubjektRozsirenyV2"',
    );
  });

  test("reports a published unreliable payer as found, marking a DIČ derived from the IČO", async () => {
    stubFetch([{ body: await fixture("adis-unreliable-payer.xml") }]);
    const result = await check({
      kind: "cz-vat-reliability",
      subject: { type: "company-id", value: "00121100" },
    });
    expect(result).toMatchObject({
      status: "found",
      subject: {
        type: "tax-id",
        value: "CZ00121100",
        derivedFrom: { type: "company-id", value: "00121100" },
      },
      findings: [{ type: "unreliable-vat-payer", publishedOn: "2017-03-16" }],
      record: { subjectType: "vat-payer", name: "LIDRU, A.S." },
    });
  });

  test("reports a DIČ the register does not hold as not-registered, not clear", async () => {
    // The captured answer was for another DIČ; the register echoes the DIČ
    // it was asked about, so the fixture is re-addressed to this one.
    const body = (await fixture("adis-not-found.xml")).replace(
      'dic="9999999999"',
      'dic="12345679"',
    );
    stubFetch([{ body }]);
    const result = await check({
      kind: "cz-vat-reliability",
      subject: { type: "company-id", value: "12345679" },
    });
    expect(result).toMatchObject({
      status: "not-registered",
      subject: { value: "CZ12345679", derivedFrom: { value: "12345679" } },
    });
  });

  test("reports an unreliable person as found", async () => {
    stubFetch([
      {
        body: adisBody(
          `${ADIS_OK}<statusSubjektu typSubjektu="NESPOLEHLIVA_OSOBA" dic="45274649" nespolehlivyPlatce="NENALEZEN" datumZverejneniNespolehlivosti="2024-01-02"><nazevSubjektu>X</nazevSubjektu></statusSubjektu>`,
        ),
      },
    ]);
    const result = await check({
      kind: "cz-vat-reliability",
      subject: { type: "tax-id", value: "CZ45274649" },
    });
    expect(result).toMatchObject({
      status: "found",
      findings: [{ type: "unreliable-person", publishedOn: "2024-01-02" }],
    });
  });

  test("answers not-covered for a person without querying", async () => {
    const requests = stubFetch([]);
    const result = await check({
      kind: "cz-vat-reliability",
      subject: {
        type: "person",
        firstName: "Jan",
        lastName: "Novák",
        birthDate: "1980-01-01",
      },
    });
    expect(result.status).toBe("not-covered");
    expect(requests).toHaveLength(0);
  });
});

describe("Czech VAT reliability check never reports clear without an explicit answer", () => {
  const PAYER = { type: "tax-id", value: "CZ45274649" } as const;
  const entry = (attributes: string) =>
    adisBody(`${ADIS_OK}<statusSubjektu dic="45274649" ${attributes}/>`);
  const failures: readonly {
    name: string;
    reply: () => Promise<Reply | Error>;
    reason: string;
  }[] = [
    ...["2", "3", "9"].map((code) => ({
      name: `status code ${code}`,
      reply: async () => ({
        body: adisBody(
          `<status odpovedGenerovana="2026-09-26" statusCode="${code}" statusText="x"/>`,
        ),
      }),
      reason: "source-error",
    })),
    {
      name: "the outage page",
      reply: async () => ({
        body: await fixture("isir-outage-page.html"),
        contentType: "text/html",
      }),
      reason: "outage-page",
    },
    {
      name: "a SOAP fault",
      reply: async () => ({
        body: '<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><soapenv:Fault><faultcode>soapenv:Server</faultcode><faultstring>x</faultstring></soapenv:Fault></soapenv:Body></soapenv:Envelope>',
        status: 500,
      }),
      reason: "soap-fault",
    },
    {
      name: "an answer for another DIČ",
      reply: async () => ({
        body: (await fixture("adis-vat-payer-clear.xml")).replace(
          'dic="45274649"',
          'dic="45274650"',
        ),
      }),
      reason: "malformed-response",
    },
    {
      name: "no subject status",
      reply: async () => ({ body: adisBody(ADIS_OK) }),
      reason: "malformed-response",
    },
    {
      name: "no status element",
      reply: async () => ({
        body: adisBody(
          '<statusSubjektu dic="45274649" typSubjektu="PLATCE_DPH" nespolehlivyPlatce="NE"/>',
        ),
      }),
      reason: "malformed-response",
    },
    {
      name: "an unknown subject type",
      reply: async () => ({
        body: entry('typSubjektu="JINY" nespolehlivyPlatce="NE"'),
      }),
      reason: "malformed-response",
    },
    {
      name: "an unknown reliability flag",
      reply: async () => ({
        body: entry('typSubjektu="PLATCE_DPH" nespolehlivyPlatce="MOZNA"'),
      }),
      reason: "malformed-response",
    },
    {
      name: "a registered payer flagged not found",
      reply: async () => ({
        body: entry('typSubjektu="PLATCE_DPH" nespolehlivyPlatce="NENALEZEN"'),
      }),
      reason: "malformed-response",
    },
    {
      name: "an unknown subject flagged unreliable",
      reply: async () => ({
        body: entry('typSubjektu="NENALEZEN" nespolehlivyPlatce="ANO"'),
      }),
      reason: "malformed-response",
    },
    {
      name: "a timeout",
      reply: async () =>
        new DOMException("The operation timed out.", "TimeoutError"),
      reason: "timeout",
    },
  ];

  for (const failure of failures) {
    test(`${failure.name} is unavailable`, async () => {
      stubFetch([await failure.reply()]);
      const result = await check({
        kind: "cz-vat-reliability",
        subject: PAYER,
      });
      expect(result.status).toBe("unavailable");
      expect(result.status === "unavailable" && result.reason).toBe(
        failure.reason,
      );
    });
  }

  test("no truncation of a clear answer reads as clear", async () => {
    const complete = await fixture("adis-vat-payer-clear.xml");
    for (let length = 0; length < complete.length; length += 1) {
      stubFetch([{ body: complete.slice(0, length) }]);
      const result = await check({
        kind: "cz-vat-reliability",
        subject: PAYER,
      });
      restoreFetch();
      if (result.status === "clear") {
        throw new Error(`truncated to ${length} characters read as clear`);
      }
    }
  });
});
