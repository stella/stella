import { afterEach, describe, expect, test } from "bun:test";

import { checkCzInsolvency } from "./cz-insolvency.js";
import { checkCzVatReliability } from "./cz-vat-reliability.js";
import type { CheckedEntityCheckSubject } from "./result.js";
import {
  readRequestSchema,
  readSoapBody,
  requestContractViolations,
} from "./soap-request-contract.helpers.js";

const FIXTURE_DIR = new URL("__fixtures__/", import.meta.url);
const fixture = async (name: string): Promise<string> =>
  await Bun.file(new URL(name, FIXTURE_DIR)).text();

const CONTRACTS = {
  "cz-insolvency.ts": {
    schema: "schemas/isir-ws-cuzk-types.xsd",
    requestElement: "getIsirWsCuzkDataRequest",
  },
  "cz-vat-reliability.ts": {
    schema: "schemas/adis-rozhrani-crpdph.wsdl",
    requestElement: "StatusNespolehlivySubjektRozsirenyV2Request",
  },
} as const;

let restoreFetch = () => {};

afterEach(() => {
  restoreFetch();
});

const captureRequests = (responses: readonly string[]): string[] => {
  const bodies: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (_input: URL | Request | string, init?: RequestInit) => {
      bodies.push(typeof init?.body === "string" ? init.body : "");
      const response = responses.at(bodies.length - 1);
      if (response === undefined) {
        throw new Error(`Unexpected request #${bodies.length}`);
      }
      return new Response(response, {
        headers: { "Content-Type": "text/xml;charset=UTF-8" },
      });
    },
    { preconnect: original.preconnect },
  );
  restoreFetch = () => {
    globalThis.fetch = original;
  };
  return bodies;
};

const schemaFor = async (
  contract: (typeof CONTRACTS)[keyof typeof CONTRACTS],
) => readRequestSchema(await fixture(contract.schema), contract.requestElement);

const expectSchemaConformant = async (
  bodies: readonly string[],
  contract: (typeof CONTRACTS)[keyof typeof CONTRACTS],
) => {
  const schema = await schemaFor(contract);
  for (const body of bodies) {
    expect(requestContractViolations(readSoapBody(body), schema)).toEqual([]);
  }
};

describe("SOAP request schema contracts", () => {
  test("covers every insolvency subject and pending-only disposition", async () => {
    const companyBodies = captureRequests([
      await fixture("isir-company-found.xml"),
      await fixture("isir-company-found-pending.xml"),
    ]);
    const company: CheckedEntityCheckSubject = {
      type: "company-id",
      value: "26863154",
    };
    await checkCzInsolvency(company, undefined, "unobserved");
    expect(companyBodies).toHaveLength(2);
    await expectSchemaConformant(companyBodies, CONTRACTS["cz-insolvency.ts"]);

    restoreFetch();
    const personBodies = captureRequests([
      await fixture("isir-person-found.xml"),
      await fixture("isir-person-found.xml"),
    ]);
    const person: CheckedEntityCheckSubject = {
      type: "person",
      firstName: "Testovaná",
      lastName: "Zkušebníková",
      birthDate: "1901-01-01",
    };
    await checkCzInsolvency(person, undefined, "unobserved");
    expect(personBodies).toHaveLength(2);
    await expectSchemaConformant(personBodies, CONTRACTS["cz-insolvency.ts"]);
    expect(personBodies.at(1)).toContain(
      "<filtrAktualniRizeni>T</filtrAktualniRizeni>",
    );
    expect(personBodies.at(1)).toContain(
      "<vyhledatBezDiakritiky>T</vyhledatBezDiakritiky>",
    );
  });

  test("covers the VAT reliability DIČ request", async () => {
    const bodies = captureRequests([await fixture("adis-vat-payer-clear.xml")]);
    const subject: CheckedEntityCheckSubject = {
      type: "tax-id",
      value: "CZ45274649",
      derivedFrom: null,
    };
    await checkCzVatReliability(subject, undefined, "unobserved");
    expect(bodies).toHaveLength(1);
    await expectSchemaConformant(bodies, CONTRACTS["cz-vat-reliability.ts"]);
  });

  test("rejects an insolvency request whose result limit follows relevance", async () => {
    const schema = await schemaFor(CONTRACTS["cz-insolvency.ts"]);
    const body = readSoapBody(await fixture("isir-request-wrong-order.xml"));
    expect(requestContractViolations(body, schema)).toContain(
      "child maxPocetVysledku is out of sequence",
    );
  });

  test("rejects VAT children without their required namespace", async () => {
    const schema = await schemaFor(CONTRACTS["cz-vat-reliability.ts"]);
    const requests = captureRequests([
      await fixture("adis-vat-payer-clear.xml"),
    ]);
    const subject: CheckedEntityCheckSubject = {
      type: "tax-id",
      value: "CZ45274649",
      derivedFrom: null,
    };
    await checkCzVatReliability(subject, undefined, "unobserved");
    const request = requests.at(0) ?? "";
    const body = readSoapBody(
      request.replace("<roz:dic", "<dic").replace("</roz:dic>", "</dic>"),
    );
    expect(requestContractViolations(body, schema)).toContain(
      `expected child {${schema.namespace}}dic, received {}dic`,
    );
  });

  test("rejects insolvency children with the types namespace", async () => {
    const schema = await schemaFor(CONTRACTS["cz-insolvency.ts"]);
    const requests = captureRequests([await fixture("isir-person-clear.xml")]);
    const company: CheckedEntityCheckSubject = {
      type: "company-id",
      value: "26863154",
    };
    await checkCzInsolvency(company, undefined, "unobserved");
    const request = requests.at(0) ?? "";
    const body = readSoapBody(
      request.replace("<ic>", "<typ:ic>").replace("</ic>", "</typ:ic>"),
    );
    expect(requestContractViolations(body, schema)).toContain(
      `expected child {}ic, received {${schema.namespace}}ic`,
    );
  });

  test("has a schema and contract case for every SOAP caller", async () => {
    const sourceDir = new URL("./", import.meta.url);
    const callers: string[] = [];
    for await (const path of new Bun.Glob("**/*.ts").scan({
      cwd: sourceDir.pathname,
    })) {
      if (
        /\bsoapRequest\(\{/u.test(
          await Bun.file(new URL(path, sourceDir)).text(),
        )
      ) {
        callers.push(path);
      }
    }
    expect(callers.toSorted()).toEqual(Object.keys(CONTRACTS).toSorted());
  });
});
