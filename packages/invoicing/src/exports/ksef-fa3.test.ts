import { describe, expect, test } from "bun:test";
import path from "node:path";

import { cents } from "@stll/money";

import type { InvoiceParty } from "../types";
import { exportRecord } from "./exports.fixtures";
import { buildKsefFa3Files } from "./ksef-fa3";
import type { InvoiceExportRecord, InvoiceExportSeller } from "./record";

// The official FA(3) schema and the crd.gov.pl type schemas it imports are
// vendored next to this test (see fixtures/ksef-fa3/README.md); the catalog
// maps the imports to those copies, so validation never touches the network.
const SCHEMAS = path.join(import.meta.dir, "fixtures", "ksef-fa3");
const XMLLINT = Bun.which("xmllint");

/**
 * What xmllint reports against the FA(3) schema; nothing when the XML is
 * valid, or when xmllint is missing (the schema tests below say so).
 */
const schemaErrors = (xml: string): string => {
  if (XMLLINT === null) {
    return "";
  }
  const result = Bun.spawnSync(
    [
      XMLLINT,
      "--nonet",
      "--noout",
      "--schema",
      path.join(SCHEMAS, "schemat.xsd"),
      "-",
    ],
    {
      stdin: new TextEncoder().encode(xml),
      env: {
        ...process.env,
        XML_CATALOG_FILES: path.join(SCHEMAS, "catalog.xml"),
      },
    },
  );
  return result.exitCode === 0 ? "" : result.stderr.toString();
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
  test("writes an ordinary VAT invoice", () => {
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
    expect(schemaErrors(xml)).toBe("");
  });

  test("names each file after its invoice number", () => {
    const files = buildKsefFa3Files([ORDINARY], GENERATED_AT).unwrap();
    expect(files.map((file) => file.fileName)).toEqual(["FV_2026_10_0042.xml"]);
  });

  test("sums each Polish rate in its own field, in schema order", () => {
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
    expect(schemaErrors(xml)).toBe("");
  });

  test("writes a paid advance invoice with the order it is paid towards", () => {
    const xml = fa3(
      polish({
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
      }),
    );
    expect(between(xml, "RodzajFaktury")).toEqual(["ZAL"]);
    expect(between(xml, "P_6")).toEqual(["2026-10-10"]);
    expect(between(xml, "P_13_1")).toEqual(["5000.00"]);
    expect(between(xml, "P_14_1")).toEqual(["1150.00"]);
    expect(between(xml, "P_15")).toEqual(["6150.00"]);
    expect(xml).not.toContain("<FaWiersz>");
    expect(between(xml, "WartoscZamowienia")).toEqual(["6150.00"]);
    expect(between(xml, "P_12Z")).toEqual(["23"]);
    expect(between(xml, "Zaplacono")).toEqual(["1"]);
    expect(between(xml, "DataZaplaty")).toEqual(["2026-10-10"]);
    expect(schemaErrors(xml)).toBe("");
  });

  test("writes an unpaid advance invoice without a payment date", () => {
    const xml = fa3(
      polish({
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
      }),
    );
    expect(between(xml, "P_6")).toEqual([]);
    expect(xml).not.toContain("<Zaplacono>");
    expect(schemaErrors(xml)).toBe("");
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

  test("a seller exempt by turnover cites art. 113 for every line", () => {
    const xml = fa3(
      polish({
        number: "1/2026",
        lines: [line("not_vat_payer"), line("not_vat_payer")],
      }),
    );
    expect(between(xml, "P_13_7")).toEqual(["2000.00"]);
    expect(xml).not.toContain("<P_14_");
    expect(between(xml, "P_19")).toEqual(["1"]);
    expect(between(xml, "P_19A")).toEqual(["art. 113 ust. 1 ustawy o VAT"]);
    expect(between(xml, "P_12")).toEqual(["zw", "zw"]);
    expect(xml).not.toContain("<P_11Vat>");
    expect(schemaErrors(xml)).toBe("");
  });

  test("an exempt seller cannot also charge VAT", () => {
    const record = polish({
      number: "2/2026",
      lines: [
        line("not_vat_payer"),
        { description: "Porada", netAmountMinor: cents(100), vatRateBps: 2300 },
      ],
    });
    expect(refusal(record)).toContain("exempt from VAT");
  });

  test("refuses an exempt line: the legal basis is not stored", () => {
    expect(
      refusal(polish({ number: "3/2026", lines: [line("exempt")] })),
    ).toContain("legal basis of the exemption");
  });

  test("a reverse charge to a Polish buyer is domestic reverse charge", () => {
    const xml = fa3(
      polish({ number: "4/2026", lines: [line("reverse_charge")] }),
    );
    expect(between(xml, "P_13_10")).toEqual(["1000.00"]);
    expect(between(xml, "P_12")).toEqual(["oo"]);
    expect(between(xml, "P_18")).toEqual(["1"]);
    expect(between(xml, "P_15")).toEqual(["1000.00"]);
    expect(schemaErrors(xml)).toBe("");
  });

  test("a reverse charge to an EU business is a service under art. 100 ust. 1 pkt 4", () => {
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
    expect(schemaErrors(xml)).toBe("");
  });

  test("a Greek buyer's VAT number carries the EL prefix", () => {
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
    expect(schemaErrors(xml)).toBe("");
  });

  test("a reverse charge to an EU buyer needs its VAT number", () => {
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

  test("a reverse charge outside the EU is a supply outside Poland", () => {
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
    expect(schemaErrors(xml)).toBe("");
  });

  test("an out-of-scope supply is outside Poland without a reverse charge", () => {
    const xml = fa3(
      polish({ number: "8/2026", lines: [line("outside_scope")] }),
    );
    expect(between(xml, "P_13_8")).toEqual(["1000.00"]);
    expect(between(xml, "P_12")).toEqual(["np I"]);
    expect(between(xml, "P_18")).toEqual(["2"]);
    expect(schemaErrors(xml)).toBe("");
  });

  test("refuses a rate Polish VAT does not have", () => {
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
  test("a foreign buyer without a tax identifier reads BrakID", () => {
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
    expect(schemaErrors(xml)).toBe("");
  });

  test("a consumer without a NIP reads BrakID", () => {
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
    expect(schemaErrors(xml)).toBe("");
  });

  test("refuses VAT on a foreign-currency invoice: no PLN exchange rate", () => {
    const record = polish({
      number: "12/2026",
      currency: "EUR",
      lines: [
        { description: "Porada", netAmountMinor: cents(100), vatRateBps: 2300 },
      ],
    });
    expect(refusal(record)).toContain("exchange rate");
  });

  test("refuses a seller without a valid NIP", () => {
    const withoutNip = polish({
      number: "13/2026",
      seller: { ...SELLER, vatId: "PL1234563219" },
      lines: [
        { description: "Porada", netAmountMinor: cents(100), vatRateBps: 2300 },
      ],
    });
    expect(refusal(withoutNip)).toContain("valid Polish NIP");
    // stdnum accepts ten zeros by checksum; the schema's pattern does not.
    const zeros = polish({
      number: "14/2026",
      seller: { ...SELLER, vatId: "0000000000" },
      lines: [
        { description: "Porada", netAmountMinor: cents(100), vatRateBps: 2300 },
      ],
    });
    expect(refusal(zeros)).toContain("valid Polish NIP");
  });

  test("finds the seller's NIP in its tax ID when the VAT ID is absent", () => {
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

  test("refuses a Polish buyer whose NIP fails the checksum", () => {
    const record = polish({
      number: "16/2026",
      buyer: { ...BUYER, vatId: "PL7250018514" },
      lines: [
        { description: "Porada", netAmountMinor: cents(100), vatRateBps: 2300 },
      ],
    });
    expect(refusal(record)).toContain("is not a valid Polish NIP");
  });

  test("refuses an invalid seller IBAN and parties without an address", () => {
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

  test("omits the bank account when the seller has none", () => {
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
    expect(schemaErrors(xml)).toBe("");
  });
});

describe("KSeF FA(3) credit notes", () => {
  test("refuses a credit note: the corrected invoice's KSeF data is not stored", () => {
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

  test("refuses an empty export", () => {
    expect(buildKsefFa3Files([], GENERATED_AT).isErr()).toBe(true);
  });
});

describe("KSeF FA(3) amounts", () => {
  test("formats minor units exactly, without binary fractions", () => {
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
    expect(schemaErrors(xml)).toBe("");
  });

  test("writes a currency without minor units as whole numbers", () => {
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
    expect(schemaErrors(xml)).toBe("");
  });

  test("refuses a currency with more decimals than FA(3) carries", () => {
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

describe.skipIf(XMLLINT === null)("FA(3) schema validation", () => {
  test("accepts the generated invoice", () => {
    expect(schemaErrors(fa3(ORDINARY))).toBe("");
  });

  test("rejects an invoice missing a mandatory field", () => {
    const xml = fa3(ORDINARY).replace(/<P_15>[^<]*<\/P_15>/u, "");
    expect(schemaErrors(xml)).toContain("P_15");
  });
});
