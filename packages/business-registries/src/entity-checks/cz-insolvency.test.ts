import { afterEach, describe, expect, test } from "bun:test";

import type { EntityCheckSubject } from "./result.js";
import { runEntityCheck } from "./run.js";
import type { RunEntityCheckOptions } from "./run.js";

// Fixtures are live ISIR_CUZK_WS responses captured on 2026-09-26:
//   isir-company-found*.xml   IČO 26863154, a company in reorganisation
//   isir-company-clear.xml    IČO 45274649, no proceedings (WS2)
//   isir-person-clear.xml     a fictitious name and birth date (WS2)
//   isir-invalid-combination  a first name without a surname (WS1)
//   isir-soap-fault.xml       an out-of-range relevance cap (HTTP 500)
//   isir-outage-page.html     the register's "system unavailable" page

const FIXTURE_DIR = new URL("__fixtures__/", import.meta.url);
const fixture = async (name: string): Promise<string> =>
  await Bun.file(new URL(name, FIXTURE_DIR)).text();

type Reply = { body: string; status?: number; contentType?: string };
type RecordedRequest = { url: string; body: string };

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
const check = async (options: RunEntityCheckOptions) =>
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
