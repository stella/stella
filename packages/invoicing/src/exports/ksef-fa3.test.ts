import { describe, expect, test } from "bun:test";
import path from "node:path";
import { validateXML } from "xmllint-wasm";

import { cents } from "@stll/money";

import type { InvoiceParty } from "../types";
import { exportRecord } from "./exports.fixtures";
import { buildKsefFa3Files } from "./ksef-fa3";
import type { InvoiceExportRecord, InvoiceExportSeller } from "./record";

// The official FA(3) schema and the crd.gov.pl type schemas it imports are
// vendored next to this test (see fixtures/ksef-fa3/README.md).
const SCHEMAS = path.join(import.meta.dir, "fixtures", "ksef-fa3");
const IMPORT_PREFIX =
  "http://crd.gov.pl/xml/schematy/dziedzinowe/mf/2022/01/05/eD/DefinicjeTypy/";
const IMPORTED_SCHEMAS = [
  "StrukturyDanych_v10-0E.xsd",
  "ElementarneTypyDanych_v10-0E.xsd",
  "KodyKrajow_v10-0E.xsd",
] as const;

const schemaText = async (fileName: string): Promise<string> =>
  (await Bun.file(path.join(SCHEMAS, fileName)).text()).replaceAll(
    `schemaLocation="${IMPORT_PREFIX}`,
    'schemaLocation="',
  );

const schemaErrors = async (xml: string): Promise<string> => {
  const result = await validateXML({
    xml: { fileName: "invoice.xml", contents: xml },
    schema: {
      fileName: "schemat.xsd",
      contents: await schemaText("schemat.xsd"),
    },
    preload: await Promise.all(
      IMPORTED_SCHEMAS.map(async (fileName) => ({
        fileName,
        contents: await schemaText(fileName),
      })),
    ),
  });
  return result.valid ? "" : result.rawOutput;
};

const GENERATED_AT = new Date("2026-10-20T08:15:30.123Z");

const between = (xml: string, tag: string): string[] =>
  [
    ...xml.matchAll(new RegExp(`<${tag}(?: [^>]*)?>([^<]*)</${tag}>`, "gu")),
  ].map((match) => match[1] ?? "");

const SELLER: InvoiceExportSeller = {
  name: "Kancelaria Prawna Kowalski i Wspólnicy sp.k.",
  registrationNumber: "0000123456",
  vatId: "PL 123-456-32-18",
  addressLine1: "ul. Marszałkowska 10/12",
  city: "Warszawa",
  postalCode: "00-590",
  country: "PL",
  iban: "PL61 1090 1014 0000 0712 1981 2874",
  bic: "WBKPPLPP",
  homeCurrency: "PLN",
};

const BUYER: InvoiceParty = {
  name: "Zielona Łąka S.A.",
  vatId: "725-001-85-13",
  addressLine1: "ul. Piotrkowska 100",
  city: "Łódź",
  postalCode: "90-004",
  country: "PL",
};

type Seed = Parameters<typeof exportRecord>[0];

const polish = (seed: Seed): InvoiceExportRecord =>
  exportRecord({
    currency: "PLN",
    issueDate: "2026-10-15",
    taxableSupplyDate: "2026-09-30",
    dueDate: "2026-10-29",
    seller: SELLER,
    buyer: BUYER,
    ...seed,
  });

const fa3 = (record: InvoiceExportRecord): string => {
  const [file] = buildKsefFa3Files([record], GENERATED_AT).unwrap();
  return file?.content ?? "";
};

const refusal = (record: InvoiceExportRecord): string => {
  const result = buildKsefFa3Files([record], GENERATED_AT);
  return result.isErr() ? result.error.message : "";
};

const ORDINARY = polish({
  number: "FV/2026/10/0042",
  notes: "Obsługa prawna za wrzesień 2026 & <due diligence>",
  lines: [
    {
      description: "Przygotowanie umowy sprzedaży udziałów",
      quantity: "4.5000",
      unit: "h",
      unitPriceMinor: cents(60_000),
      netAmountMinor: cents(270_000),
      vatRateBps: 2300,
      source: "time_entry",
    },
    {
      description: "Opinia prawna",
      netAmountMinor: cents(150_000),
      vatRateBps: 2300,
    },
  ],
});

describe("KSeF FA(3)", () => {
  test("writes an ordinary VAT invoice", async () => {
    const xml = fa3(ORDINARY);
    expect(xml).toStartWith(
      '<?xml version="1.0" encoding="UTF-8"?>\n<Faktura xmlns="http://crd.gov.pl/wzor/2025/06/25/13775/">',
    );
    expect(xml).toContain(
      '<KodFormularza kodSystemowy="FA (3)" wersjaSchemy="1-0E">FA</KodFormularza><WariantFormularza>3</WariantFormularza><DataWytworzeniaFa>2026-10-20T08:15:30Z</DataWytworzeniaFa><SystemInfo>stella</SystemInfo>',
    );
    expect(between(xml, "NIP")).toEqual(["1234563218", "7250018513"]);
    expect(between(xml, "AdresL2")).toEqual(["00-590 Warszawa", "90-004 Łódź"]);
    expect(between(xml, "JST")).toEqual(["2"]);
    expect(between(xml, "P_1")).toEqual(["2026-10-15"]);
    expect(between(xml, "P_2")).toEqual(["FV/2026/10/0042"]);
    expect(between(xml, "P_6")).toEqual(["2026-09-30"]);
    expect(between(xml, "P_13_1")).toEqual(["4200.00"]);
    expect(between(xml, "P_14_1")).toEqual(["966.00"]);
    expect(between(xml, "P_15")).toEqual(["5166.00"]);
    expect(between(xml, "P_18")).toEqual(["2"]);
    expect(between(xml, "P_19N")).toEqual(["1"]);
    expect(between(xml, "RodzajFaktury")).toEqual(["VAT"]);
    expect(between(xml, "P_8A")).toEqual(["h"]);
    expect(between(xml, "P_8B")).toEqual(["4.5", "1"]);
    expect(between(xml, "P_9A")).toEqual(["600.00", "1500.00"]);
    expect(between(xml, "P_11Vat")).toEqual(["621.00", "345.00"]);
    expect(between(xml, "P_12")).toEqual(["23", "23"]);
    expect(between(xml, "Termin")).toEqual(["2026-10-29"]);
    expect(between(xml, "FormaPlatnosci")).toEqual(["6"]);
    expect(between(xml, "NrRB")).toEqual(["61109010140000071219812874"]);
    expect(between(xml, "SWIFT")).toEqual(["WBKPPLPP"]);
    expect(xml).toContain("&amp; &lt;due diligence&gt;");
    expect(xml).not.toContain("<PrefiksPodatnika>");
    expect(await schemaErrors(xml)).toBe("");
  });

  test("names each file after its invoice number", async () => {
    const files = buildKsefFa3Files([ORDINARY], GENERATED_AT).unwrap();
    expect(files.map((file) => file.fileName)).toEqual(["FV_2026_10_0042.xml"]);
  });

  test("sums each Polish rate in its own field, in schema order", async () => {
    const xml = fa3(
      polish({
        number: "FV/2026/2",
        lines: [
          {
            description: "Porada",
            netAmountMinor: cents(100_000),
            vatRateBps: 2300,
          },
          {
            description: "Usługa 8 %",
            netAmountMinor: cents(50_000),
            vatRateBps: 800,
          },
          {
            description: "Książka",
            netAmountMinor: cents(10_000),
            vatRateBps: 500,
          },
          {
            description: "Stawka 0 %",
            netAmountMinor: cents(7000),
            vatRateBps: 0,
          },
          {
            description: "Porada 2",
            netAmountMinor: cents(20_000),
            vatRateBps: 2300,
          },
        ],
      }),
    );
    expect(between(xml, "P_13_1")).toEqual(["1200.00"]);
    expect(between(xml, "P_14_1")).toEqual(["276.00"]);
    expect(between(xml, "P_13_2")).toEqual(["500.00"]);
    expect(between(xml, "P_14_2")).toEqual(["40.00"]);
    expect(between(xml, "P_13_3")).toEqual(["100.00"]);
    expect(between(xml, "P_14_3")).toEqual(["5.00"]);
    expect(between(xml, "P_13_6_1")).toEqual(["70.00"]);
    expect(between(xml, "P_15")).toEqual(["2191.00"]);
    expect(between(xml, "P_12")).toEqual(["23", "8", "5", "0 KR", "23"]);
    expect(await schemaErrors(xml)).toBe("");
  });

  test("refuses a paid advance invoice because its order is not stored", () => {
    const record = polish({
      number: "FZ/2026/7",
      documentType: "advance",
      taxableSupplyDate: null,
      status: "paid",
      paidDate: "2026-10-10",
      lines: [
        {
          description: "Zaliczka na obsługę transakcji",
          netAmountMinor: cents(500_000),
          vatRateBps: 2300,
        },
      ],
    });
    expect(refusal(record)).toContain(
      "an advance invoice needs the value and lines of the order it is paid towards, which stella does not store",
    );
  });

  test("refuses an unpaid advance invoice because its order is not stored", () => {
    const record = polish({
      number: "FZ/2026/8",
      documentType: "advance",
      taxableSupplyDate: null,
      lines: [
        {
          description: "Zaliczka",
          netAmountMinor: cents(100_000),
          vatRateBps: 2300,
        },
      ],
    });
    expect(refusal(record)).toContain(
      "an advance invoice needs the value and lines of the order it is paid towards, which stella does not store",
    );
  });
});

describe("KSeF FA(3) payment and files", () => {
  test("marks an invoice paid only when it was paid by its issue date", async () => {
    const paidOn = (paidDate: string) =>
      fa3({ ...ORDINARY, status: "paid", paidDate });
    expect(between(paidOn("2026-10-15"), "Zaplacono")).toEqual(["1"]);
    expect(between(paidOn("2026-10-15"), "DataZaplaty")).toEqual([
      "2026-10-15",
    ]);
    const later = paidOn("2026-10-20");
    expect(between(later, "Zaplacono")).toEqual([]);
    expect(between(later, "DataZaplaty")).toEqual([]);
    expect(await schemaErrors(later)).toBe("");
  });

  test("keeps file names unique when invoice numbers collide", async () => {
    const files = buildKsefFa3Files(
      [
        { ...ORDINARY, number: "FV/1" },
        { ...ORDINARY, number: "FV_1" },
        { ...ORDINARY, number: "fv_1" },
      ],
      GENERATED_AT,
    ).unwrap();
    expect(files.map((file) => file.fileName)).toEqual([
      "FV_1.xml",
      "FV_1-2.xml",
      "fv_1-3.xml",
    ]);
  });
});

describe("KSeF FA(3) VAT treatments", () => {
  const line = (
    vatTreatment: InvoiceExportRecord["lines"][number]["vatTreatment"],
  ) => ({
    description: "Doradztwo prawne",
    netAmountMinor: cents(100_000),
    vatRateBps: 0,
    vatTreatment,
  });

  test("refuses a seller outside VAT: the exemption's legal basis is not stored", async () => {
    // Being outside VAT names no legal basis; art. 113 ust. 1 cannot be assumed
    // (ust. 13 pkt 2 lit. a excludes legal services from it).
    expect(
      refusal(
        polish({
          number: "1/2026",
          lines: [line("not_vat_payer"), line("not_vat_payer")],
        }),
      ),
    ).toContain("legal basis of the exemption");
    expect(
      refusal(
        polish({
          number: "2/2026",
          lines: [
            line("not_vat_payer"),
            {
              description: "Porada",
              netAmountMinor: cents(100),
              vatRateBps: 2300,
            },
          ],
        }),
      ),
    ).toContain("legal basis of the exemption");
  });

  test("refuses an exempt line: the legal basis is not stored", async () => {
    expect(
      refusal(polish({ number: "3/2026", lines: [line("exempt")] })),
    ).toContain("legal basis of the exemption");
  });

  test("a reverse charge to a Polish buyer is domestic reverse charge", async () => {
    const xml = fa3(
      polish({ number: "4/2026", lines: [line("reverse_charge")] }),
    );
    expect(between(xml, "P_13_10")).toEqual(["1000.00"]);
    expect(between(xml, "P_12")).toEqual(["oo"]);
    expect(between(xml, "P_18")).toEqual(["1"]);
    expect(between(xml, "P_15")).toEqual(["1000.00"]);
    expect(await schemaErrors(xml)).toBe("");
  });

  test("a reverse charge to an EU business is a service under art. 100 ust. 1 pkt 4", async () => {
    const xml = fa3(
      polish({
        number: "5/2026",
        currency: "EUR",
        buyer: {
          name: "Grüne Wiese GmbH",
          vatId: "DE 123456789",
          addressLine1: "Hauptstraße 1",
          city: "München",
          postalCode: "80331",
          country: "DE",
        },
        lines: [line("reverse_charge")],
      }),
    );
    expect(between(xml, "KodWaluty")).toEqual(["EUR"]);
    expect(between(xml, "PrefiksPodatnika")).toEqual(["PL"]);
    expect(between(xml, "KodUE")).toEqual(["DE"]);
    expect(between(xml, "NrVatUE")).toEqual(["123456789"]);
    expect(between(xml, "P_13_9")).toEqual(["1000.00"]);
    expect(between(xml, "P_12")).toEqual(["np II"]);
    expect(between(xml, "P_18")).toEqual(["1"]);
    expect(between(xml, "KodKraju")).toEqual(["PL", "DE"]);
    expect(await schemaErrors(xml)).toBe("");
  });

  test("a Greek buyer's VAT number carries the EL prefix", async () => {
    const xml = fa3(
      polish({
        number: "5a/2026",
        buyer: {
          name: "Ελιά Α.Ε.",
          vatId: "EL094259216",
          addressLine1: "Οδός Ερμού 1",
          city: "Αθήνα",
          country: "GR",
        },
        lines: [line("reverse_charge")],
      }),
    );
    expect(between(xml, "KodUE")).toEqual(["EL"]);
    expect(between(xml, "NrVatUE")).toEqual(["094259216"]);
    expect(await schemaErrors(xml)).toBe("");
  });

  test("the VAT number's own EU prefix wins over the address country", async () => {
    const euBuyer = (country: string, vatId: string) =>
      polish({
        number: "5b/2026",
        buyer: {
          name: "Buyer",
          vatId,
          addressLine1: "Street 1",
          city: "City",
          country,
        },
        lines: [line("reverse_charge")],
      });
    const cases = [
      // An explicit registration prefix decides even where the rest also fits
      // the address country's format (a German registration in France).
      {
        country: "FR",
        vatId: "DE123456789",
        prefix: "DE",
        number: "123456789",
      },
      {
        country: "FR",
        vatId: "EL123456789",
        prefix: "EL",
        number: "123456789",
      },
      {
        country: "CZ",
        vatId: "DE123456789",
        prefix: "DE",
        number: "123456789",
      },
      { country: "LU", vatId: "LU15027442", prefix: "LU", number: "15027442" },
      { country: "MT", vatId: "MT12345678", prefix: "MT", number: "12345678" },
      {
        country: "FR",
        vatId: "AB123456789",
        prefix: "FR",
        number: "AB123456789",
      },
    ] as const;

    for (const entry of cases) {
      const xml = fa3(euBuyer(entry.country, entry.vatId));
      expect(between(xml, "KodUE")).toEqual([entry.prefix]);
      expect(between(xml, "NrVatUE")).toEqual([entry.number]);
      expect(await schemaErrors(xml)).toBe("");
    }
  });

  test("the VAT registration decides before the address", async () => {
    const cases = [
      { country: "PL", vatId: "DE123456789", zone: "eu" },
      { country: "DE", vatId: "PL 725-001-85-13", zone: "domestic" },
      { country: "PL", vatId: "PL 725-001-85-13", zone: "domestic" },
      { country: "DE", vatId: "DE123456789", zone: "eu" },
    ] as const;

    for (const [index, entry] of cases.entries()) {
      const xml = fa3(
        polish({
          number: `5${index}/2026`,
          buyer: {
            ...BUYER,
            vatId: entry.vatId,
            country: entry.country,
          },
          lines: [line("reverse_charge")],
        }),
      );
      if (entry.zone === "eu") {
        expect(between(xml, "KodUE")).toEqual(["DE"]);
        expect(between(xml, "NrVatUE")).toEqual(["123456789"]);
        expect(between(xml, "NIP")).toEqual(["1234563218"]);
        expect(between(xml, "P_13_9")).toEqual(["1000.00"]);
        expect(between(xml, "P_13_10")).toEqual([]);
        expect(between(xml, "P_12")).toEqual(["np II"]);
      } else {
        expect(between(xml, "KodUE")).toEqual([]);
        expect(between(xml, "NrVatUE")).toEqual([]);
        expect(between(xml, "NIP")).toEqual(["1234563218", "7250018513"]);
        expect(between(xml, "P_13_9")).toEqual([]);
        expect(between(xml, "P_13_10")).toEqual(["1000.00"]);
        expect(between(xml, "P_12")).toEqual(["oo"]);
      }
      expect(await schemaErrors(xml)).toBe("");
    }
  });

  test("refuses an EU VAT number that does not fit its own country", async () => {
    // Eight digits fit Danish or Finnish numbers, never a German one.
    const record = polish({
      number: "16a/2026",
      buyer: { ...BUYER, vatId: "DE12345678" },
      lines: [line("reverse_charge")],
    });
    expect(refusal(record)).toContain("is not valid");
  });

  test("a service to a Northern Ireland registration is supplied outside the EU", async () => {
    const xml = fa3(
      polish({
        number: "5x/2026",
        buyer: {
          name: "Belfast Legal Ltd",
          vatId: "XI123456789",
          addressLine1: "1 Donegall Square",
          city: "Belfast",
          postalCode: "BT1 5GS",
          country: "GB",
        },
        lines: [line("reverse_charge")],
      }),
    );
    expect(between(xml, "KodUE")).toEqual(["XI"]);
    expect(between(xml, "P_13_8")).toEqual(["1000.00"]);
    expect(xml).not.toContain("<P_13_9>");
    expect(between(xml, "P_12")).toEqual(["np I"]);
    expect(await schemaErrors(xml)).toBe("");
  });

  test("a reverse charge to an EU buyer needs its VAT number", async () => {
    const record = polish({
      number: "6/2026",
      buyer: {
        name: "Jan Novák",
        addressLine1: "Vodičkova 1",
        city: "Praha",
        country: "CZ",
      },
      lines: [line("reverse_charge")],
    });
    expect(refusal(record)).toContain("EU VAT number");
  });

  test("a reverse charge outside the EU is a supply outside Poland", async () => {
    const xml = fa3(
      polish({
        number: "7/2026",
        currency: "USD",
        buyer: {
          name: "Green Meadow Inc.",
          taxId: "12-3456789",
          addressLine1: "1 Main Street",
          city: "New York",
          postalCode: "10001",
          country: "US",
        },
        lines: [line("reverse_charge")],
      }),
    );
    expect(between(xml, "KodKraju")).toEqual(["PL", "US", "US"]);
    expect(between(xml, "NrID")).toEqual(["12-3456789"]);
    expect(between(xml, "P_13_8")).toEqual(["1000.00"]);
    expect(between(xml, "P_12")).toEqual(["np I"]);
    expect(between(xml, "P_18")).toEqual(["1"]);
    expect(await schemaErrors(xml)).toBe("");
  });

  test("an out-of-scope supply is outside Poland without a reverse charge", async () => {
    const xml = fa3(
      polish({ number: "8/2026", lines: [line("outside_scope")] }),
    );
    expect(between(xml, "P_13_8")).toEqual(["1000.00"]);
    expect(between(xml, "P_12")).toEqual(["np I"]);
    expect(between(xml, "P_18")).toEqual(["2"]);
    expect(await schemaErrors(xml)).toBe("");
  });

  test("refuses a rate Polish VAT does not have", async () => {
    const record = polish({
      number: "9/2026",
      lines: [
        { description: "Porada", netAmountMinor: cents(100), vatRateBps: 2100 },
      ],
    });
    expect(refusal(record)).toContain("21 % is not a Polish VAT rate");
  });
});

describe("KSeF FA(3) parties", () => {
  test("a foreign buyer without a tax identifier reads BrakID", async () => {
    const xml = fa3(
      polish({
        number: "10/2026",
        currency: "CHF",
        buyer: {
          name: "Grüne Wiese AG",
          addressLine1: "Bahnhofstrasse 1",
          city: "Zürich",
          postalCode: "8001",
          country: "CH",
        },
        lines: [
          {
            description: "Legal advice",
            netAmountMinor: cents(100_000),
            vatRateBps: 0,
            vatTreatment: "outside_scope",
          },
        ],
      }),
    );
    expect(between(xml, "BrakID")).toEqual(["1"]);
    expect(between(xml, "KodKraju")).toEqual(["PL", "CH"]);
    expect(await schemaErrors(xml)).toBe("");
  });

  test("a consumer without a NIP reads BrakID", async () => {
    const xml = fa3(
      polish({
        number: "11/2026",
        buyer: {
          name: "Anna Nowak",
          addressLine1: "ul. Długa 5",
          city: "Kraków",
          postalCode: "31-147",
        },
        lines: [
          {
            description: "Porada",
            netAmountMinor: cents(50_000),
            vatRateBps: 2300,
          },
        ],
      }),
    );
    expect(between(xml, "NIP")).toEqual(["1234563218"]);
    expect(between(xml, "BrakID")).toEqual(["1"]);
    expect(between(xml, "KodKraju")).toEqual(["PL", "PL"]);
    expect(await schemaErrors(xml)).toBe("");
  });

  test("refuses VAT on a foreign-currency invoice: no PLN exchange rate", async () => {
    const record = polish({
      number: "12/2026",
      currency: "EUR",
      lines: [
        { description: "Porada", netAmountMinor: cents(100), vatRateBps: 2300 },
      ],
    });
    expect(refusal(record)).toContain("exchange rate");
  });

  test("refuses a seller without a valid NIP", async () => {
    const withoutNip = polish({
      number: "13/2026",
      seller: { ...SELLER, vatId: "PL1234563219" },
      lines: [
        { description: "Porada", netAmountMinor: cents(100), vatRateBps: 2300 },
      ],
    });
    expect(refusal(withoutNip)).toContain("valid Polish NIP");
    // Ten zeros pass the checksum; the schema's pattern does not.
    const zeros = polish({
      number: "14/2026",
      seller: { ...SELLER, vatId: "0000000000" },
      lines: [
        { description: "Porada", netAmountMinor: cents(100), vatRateBps: 2300 },
      ],
    });
    expect(refusal(zeros)).toContain("valid Polish NIP");
  });

  test("finds the seller's NIP in its tax ID when the VAT ID is absent", async () => {
    const { vatId: _omitted, ...seller } = SELLER;
    const xml = fa3(
      polish({
        number: "15/2026",
        seller: { ...seller, taxId: "1234563218" },
        lines: [
          {
            description: "Porada",
            netAmountMinor: cents(100),
            vatRateBps: 2300,
          },
        ],
      }),
    );
    expect(between(xml, "NIP")[0]).toBe("1234563218");
  });

  test("refuses a Polish buyer whose NIP fails the checksum", async () => {
    const record = polish({
      number: "16/2026",
      buyer: { ...BUYER, vatId: "PL7250018514" },
      lines: [
        { description: "Porada", netAmountMinor: cents(100), vatRateBps: 2300 },
      ],
    });
    expect(refusal(record)).toContain("is not a valid Polish NIP");
  });

  test("refuses an invalid seller IBAN and parties without an address", async () => {
    const lines = [
      { description: "Porada", netAmountMinor: cents(100), vatRateBps: 2300 },
    ];
    expect(
      refusal(
        polish({
          number: "17/2026",
          seller: { ...SELLER, iban: "PL61109010140000071219812875" },
          lines,
        }),
      ),
    ).toContain("IBAN");
    expect(
      refusal(
        polish({ number: "18/2026", buyer: { name: "Bez adresu" }, lines }),
      ),
    ).toContain("buyer's address");
  });

  test("omits the bank account when the seller has none", async () => {
    const { iban: _iban, bic: _bic, ...seller } = SELLER;
    const xml = fa3(
      polish({
        number: "19/2026",
        seller,
        lines: [
          {
            description: "Porada",
            netAmountMinor: cents(100),
            vatRateBps: 2300,
          },
        ],
      }),
    );
    expect(xml).not.toContain("<RachunekBankowy>");
    expect(between(xml, "Termin")).toEqual(["2026-10-29"]);
    expect(await schemaErrors(xml)).toBe("");
  });
});

describe("KSeF FA(3) credit notes", () => {
  test("refuses a credit note: the corrected invoice's KSeF data is not stored", async () => {
    const creditNote = polish({
      number: "KOR/2026/1",
      documentType: "credit_note",
      originalNumber: "FV/2026/10/0042",
      lines: [
        {
          description: "Rabat",
          unitPriceMinor: cents(-10_000),
          netAmountMinor: cents(-10_000),
          vatRateBps: 2300,
        },
      ],
    });
    const message = refusal(creditNote);
    expect(message).toContain("KOR/2026/1");
    expect(message).toContain("KSeF number");
    // One refused record refuses the whole export, as the other formats do.
    expect(
      buildKsefFa3Files([ORDINARY, creditNote], GENERATED_AT).isErr(),
    ).toBe(true);
  });

  test("refuses an empty export", async () => {
    expect(buildKsefFa3Files([], GENERATED_AT).isErr()).toBe(true);
  });
});

describe("KSeF FA(3) amounts", () => {
  test("formats minor units exactly, without binary fractions", async () => {
    const xml = fa3(
      polish({
        number: "20/2026",
        lines: [
          { description: "Grosz", netAmountMinor: cents(1), vatRateBps: 2300 },
          {
            description: "Duża kwota",
            netAmountMinor: cents(90_071_992_547_409),
            vatRateBps: 0,
          },
          {
            description: "Ułamek",
            quantity: "0.3333",
            unitPriceMinor: cents(30),
            netAmountMinor: cents(10),
            vatRateBps: 2300,
          },
          {
            description: "Rabat",
            unitPriceMinor: cents(-5),
            netAmountMinor: cents(-5),
            vatRateBps: 2300,
          },
        ],
      }),
    );
    expect(between(xml, "P_11")).toEqual([
      "0.01",
      "900719925474.09",
      "0.10",
      "-0.05",
    ]);
    expect(between(xml, "P_11Vat")).toEqual(["0.00", "0.00", "0.02", "-0.01"]);
    expect(between(xml, "P_8B")).toEqual(["1", "1", "0.3333", "1"]);
    expect(between(xml, "P_9A")).toEqual([
      "0.01",
      "900719925474.09",
      "0.30",
      "-0.05",
    ]);
    expect(between(xml, "P_13_1")).toEqual(["0.06"]);
    expect(between(xml, "P_14_1")).toEqual(["0.01"]);
    expect(await schemaErrors(xml)).toBe("");
  });

  test("derives the net unit price when none is stored (art. 106e ust. 1 pkt 9)", async () => {
    const withoutPrice = (quantity: string, netAmountMinor: number) =>
      polish({
        number: "21a/2026",
        lines: [
          {
            description: "Obsługa prawna",
            quantity,
            unitPriceMinor: null,
            netAmountMinor: cents(netAmountMinor),
            vatRateBps: 2300,
          },
        ],
      });
    const xml = fa3(withoutPrice("2.0000", 100_000));
    expect(between(xml, "P_8B")).toEqual(["2"]);
    expect(between(xml, "P_9A")).toEqual(["500.00"]);
    expect(between(xml, "P_11")).toEqual(["1000.00"]);
    expect(await schemaErrors(xml)).toBe("");
    expect(between(fa3(withoutPrice("0.1250", 100_000)), "P_9A")).toEqual([
      "8000.00",
    ]);
    // 1000.00 over 1.5 hours is 666.67 only after rounding: no exact price.
    expect(refusal(withoutPrice("1.5000", 100_000))).toContain(
      "net unit price",
    );
    expect(refusal(withoutPrice("0.0000", 100_000))).toContain(
      "net unit price",
    );
  });

  test("writes a currency without minor units as whole numbers", async () => {
    const xml = fa3(
      polish({
        number: "21/2026",
        currency: "JPY",
        lines: [
          {
            description: "Legal advice",
            netAmountMinor: cents(150_000),
            vatRateBps: 0,
            vatTreatment: "outside_scope",
          },
        ],
      }),
    );
    expect(between(xml, "P_13_8")).toEqual(["150000"]);
    expect(between(xml, "P_15")).toEqual(["150000"]);
    expect(await schemaErrors(xml)).toBe("");
  });

  test("refuses a currency with more decimals than FA(3) carries", async () => {
    const record = polish({
      number: "22/2026",
      currency: "KWD",
      lines: [
        {
          description: "Legal advice",
          netAmountMinor: cents(1005),
          vatRateBps: 0,
          vatTreatment: "outside_scope",
        },
      ],
    });
    expect(refusal(record)).toContain("two decimals");
  });
});

describe("FA(3) schema validation", () => {
  test("accepts the generated invoice", async () => {
    expect(await schemaErrors(fa3(ORDINARY))).toBe("");
  });

  test("rejects an invoice missing a mandatory field", async () => {
    const xml = fa3(ORDINARY).replace(/<P_15>[^<]*<\/P_15>/u, "");
    expect(await schemaErrors(xml)).toContain("Adnotacje");
  });
});
