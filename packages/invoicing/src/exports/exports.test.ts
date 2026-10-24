import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { cents } from "@stll/money";
import { assertProperty } from "@stll/property-testing";

import {
  ADVANCE_INVOICE,
  CREDIT_NOTE,
  DOMESTIC_INVOICE,
  EURO_INVOICE,
  exportRecord,
  MIXED_RATES_INVOICE,
} from "./exports.fixtures";
import { buildFlexibeeXml } from "./flexibee";
import { buildIsdocFiles } from "./isdoc";
import { buildLedes1998b } from "./ledes";
import { buildMoneyS3Xml } from "./money-s3";
import { buildPohodaXml } from "./pohoda";
import {
  quantityText,
  splitCzechAccountNumber,
  variableSymbolOf,
} from "./record";
import {
  buildEso9Table,
  buildInvoiceLinesTable,
  buildInvoiceSummaryTable,
  type InvoiceTableCell,
} from "./tables";
import { buildUblFiles } from "./ubl";

const between = (xml: string, tag: string): string[] =>
  [
    ...xml.matchAll(new RegExp(`<${tag}(?: [^>]*)?>([^<]*)</${tag}>`, "gu")),
  ].map((match) => match[1] ?? "");

describe("export record helpers", () => {
  test("variable symbol prefers a numeric reference, else the number's digits", () => {
    expect(variableSymbolOf({ number: "FV-2026/0016", reference: null })).toBe(
      "20260016",
    );
    expect(variableSymbolOf({ number: "20260016", reference: "777" })).toBe(
      "777",
    );
    expect(
      variableSymbolOf({ number: "2026000000016", reference: "PO-1" }),
    ).toBeNull();
  });

  test("quantity drops the stored trailing zeros", () => {
    expect(quantityText("4.5000")).toBe("4.5");
    expect(quantityText("2.0000")).toBe("2");
    expect(quantityText(null)).toBe("1");
  });

  test("a Czech account number splits into account and bank code", () => {
    expect(splitCzechAccountNumber("19-2000145399/0800")).toEqual({
      account: "19-2000145399",
      bankCode: "0800",
    });
    expect(splitCzechAccountNumber("CZ6508000000192000145399")).toBeNull();
  });
});

describe("POHODA XML", () => {
  test("types each document and escapes text", () => {
    const xml = buildPohodaXml(
      [DOMESTIC_INVOICE, CREDIT_NOTE, ADVANCE_INVOICE],
      "export-1",
    ).unwrap();
    expect(between(xml, "inv:invoiceType")).toEqual([
      "issuedInvoice",
      "issuedCreditNotice",
      "issuedAdvanceInvoice",
    ]);
    expect(between(xml, "inv:originalDocument")).toEqual(["20260016"]);
    expect(xml).toContain("&amp; due diligence &lt;A&gt;");
    expect(xml).toContain('ico="12345678"');
    // The buyer is the partner, the seller the package's own identity.
    expect(xml.indexOf("<inv:partnerIdentity>")).toBeLessThan(
      xml.indexOf("<inv:myIdentity>"),
    );
  });

  test("maps Czech VAT rates onto POHODA's rate slots", () => {
    const xml = buildPohodaXml([MIXED_RATES_INVOICE], "export-1").unwrap();
    expect(between(xml, "inv:rateVAT")).toEqual(["high", "third", "low"]);
  });

  test("states a foreign-currency invoice in its currency", () => {
    const xml = buildPohodaXml([EURO_INVOICE], "export-1").unwrap();
    expect(xml).toContain("<inv:foreignCurrency>");
    expect(xml).toContain("<typ:ids>EUR</typ:ids>");
    expect(xml).not.toContain("<inv:homeCurrency>");
  });

  test("refuses a package without the seller's company ID", () => {
    const { registrationNumber: _omitted, ...seller } = DOMESTIC_INVOICE.seller;
    const record = exportRecord({
      number: "1",
      seller,
      lines: [{ description: "Work", netAmountMinor: cents(100) }],
    });
    expect(buildPohodaXml([record], "export-1").isErr()).toBe(true);
  });
});

describe("Money S3 XML", () => {
  test("sums bases and VAT by Czech rate band", () => {
    const xml = buildMoneyS3Xml([MIXED_RATES_INVOICE]).unwrap();
    expect(between(xml, "Zaklad22")).toEqual(["1000.00"]);
    expect(between(xml, "DPH22")).toEqual(["210.00"]);
    expect(between(xml, "Zaklad5")).toEqual(["800.00"]);
    expect(between(xml, "DPH5")).toEqual(["120.00"]);
    expect(between(xml, "SazbaDPH1")).toEqual(["15"]);
    expect(between(xml, "Sazba")).toEqual(["10"]);
    expect(between(xml, "Uhrazeno")).toEqual(["2023-12-10"]);
  });

  test("flags credit notes and advance invoices", () => {
    const xml = buildMoneyS3Xml([CREDIT_NOTE, ADVANCE_INVOICE]).unwrap();
    expect(between(xml, "Dobropis")).toEqual(["1", "0"]);
    expect(between(xml, "Druh")).toEqual(["N", "L"]);
    expect(between(xml, "PuvDoklad")).toEqual(["20260016"]);
    expect(between(xml, "Celkem")).toEqual(["-1210.00", "6050.00"]);
  });

  test("refuses what Money S3 cannot hold", () => {
    expect(buildMoneyS3Xml([EURO_INVOICE]).isErr()).toBe(true);
    const longNumber = exportRecord({
      number: "FV-2026-000016",
      lines: [{ description: "Work", netAmountMinor: cents(100) }],
    });
    expect(buildMoneyS3Xml([longNumber]).isErr()).toBe(true);
  });
});

describe("ABRA Flexi XML", () => {
  test("lists each buyer once and keys records for re-import", () => {
    const xml = buildFlexibeeXml([
      DOMESTIC_INVOICE,
      CREDIT_NOTE,
      EURO_INVOICE,
    ]).unwrap();
    expect(xml.match(/<adresar>/gu)).toHaveLength(2);
    expect(between(xml, "typDokl")).toEqual([
      "code:FAKTURA",
      "code:DOBROPIS",
      "code:FAKTURA",
    ]);
    expect(between(xml, "mena")).toEqual(["code:CZK", "code:CZK", "code:EUR"]);
    expect(xml).toContain(
      "<id>ext:STELLA:invoice:0192d6a4-7c1e-7b55-9a3e-2f1b6c8d4e01</id>",
    );
  });
});

describe("ISDOC", () => {
  test("writes one document per invoice with matching totals", () => {
    const files = buildIsdocFiles([DOMESTIC_INVOICE, CREDIT_NOTE]).unwrap();
    expect(files.map((file) => file.fileName)).toEqual([
      "20260016.isdoc",
      "20260017.isdoc",
    ]);
    const [invoice, creditNote] = files.map((file) => file.content);
    expect(between(invoice ?? "", "DocumentType")).toEqual(["1"]);
    expect(between(invoice ?? "", "PayableAmount")).toEqual(["18335.00"]);
    expect(between(invoice ?? "", "VariableSymbol")).toEqual(["20260016"]);
    expect(between(creditNote ?? "", "DocumentType")).toEqual(["2"]);
    expect(creditNote).toContain("<OriginalDocumentReferences>");
    expect(creditNote).not.toContain("<PaymentMeans>");
  });

  test("refuses an invoice outside the local currency", () => {
    expect(buildIsdocFiles([EURO_INVOICE]).isErr()).toBe(true);
  });

  test("states a reverse charge at 0 % in its line and its subtotal", () => {
    const reverseCharge = {
      ...DOMESTIC_INVOICE,
      lines: DOMESTIC_INVOICE.lines.map((line) => ({
        ...line,
        vatTreatment: "reverse_charge" as const,
        vatRateBps: 2100,
        vatAmountMinor: cents(0),
        grossAmountMinor: line.netAmountMinor,
      })),
    };
    const [file] = buildIsdocFiles([reverseCharge]).unwrap();
    const percents = between(file?.content ?? "", "Percent");
    expect(percents.length).toBeGreaterThan(1);
    expect(new Set(percents)).toEqual(new Set(["0"]));
  });
});

describe("UBL 2.1 (EN 16931)", () => {
  test("writes credit notes as positive CreditNote documents", () => {
    const [invoice, creditNote] = buildUblFiles([DOMESTIC_INVOICE, CREDIT_NOTE])
      .unwrap()
      .map((file) => file.content);
    expect(invoice).toContain("<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>");
    expect(between(invoice ?? "", "cbc:PayableAmount")).toEqual(["18335.00"]);
    expect(between(invoice ?? "", "cbc:PaymentID")).toEqual(["20260016"]);
    expect(creditNote).toStartWith(
      '<?xml version="1.0" encoding="UTF-8"?>\n<CreditNote ',
    );
    expect(between(creditNote ?? "", "cbc:PayableAmount")).toEqual(["1210.00"]);
    expect(creditNote).toContain(
      "<cac:InvoiceDocumentReference><cbc:ID>20260016</cbc:ID>",
    );
  });

  test("refuses a party without a two-letter country code", () => {
    const result = buildUblFiles([
      { ...MIXED_RATES_INVOICE, buyer: { name: "Bez adresy" } },
    ]);
    expect(result.isErr()).toBe(true);
  });

  test("classifies VAT and bills hours in hours", () => {
    const [invoice] = buildUblFiles([DOMESTIC_INVOICE])
      .unwrap()
      .map((file) => file.content);
    expect(invoice).toContain('<cbc:InvoicedQuantity unitCode="HUR">4.5<');
    expect(between(invoice ?? "", "cbc:TaxExemptionReason")).toEqual([
      "Exempt from VAT",
    ]);
    const [euro] = buildUblFiles([EURO_INVOICE])
      .unwrap()
      .map((file) => file.content);
    expect(euro).toContain("<cbc:ID>AE</cbc:ID>");
    expect(euro).toContain('currencyID="EUR"');
  });
});

describe("LEDES 1998B", () => {
  const file = buildLedes1998b([DOMESTIC_INVOICE, CREDIT_NOTE]).unwrap();
  const records = file.trimEnd().split("\r\n");

  test("writes the 24-field header and one record per line", () => {
    expect(records[0]).toBe("LEDES1998B[]");
    expect(records[1]?.split("|")).toHaveLength(24);
    expect(records).toHaveLength(5);
    for (const record of records.slice(1)) {
      expect(record.endsWith("[]")).toBe(true);
      expect(record.split("|")).toHaveLength(24);
    }
  });

  test("types fees, expenses and adjustments with their codes", () => {
    const [fee, expense, adjustment] = records
      .slice(2)
      .map((record) => record.split("|"));
    expect(fee?.slice(9, 17)).toEqual([
      "F",
      "4.5",
      "0",
      "13500.00",
      "20260912",
      "L120",
      "",
      "A103",
    ]);
    expect(fee?.[21]).toBe("Jana Nováková");
    expect(expense?.[9]).toBe("E");
    expect(expense?.[15]).toBe("E112");
    expect(adjustment?.[9]).toBe("IF");
    expect(adjustment?.[4]).toBe("-1000.00");
  });

  test("keeps delimiters out of field values", () => {
    const record = exportRecord({
      number: "1",
      lines: [
        {
          description: "Call | follow-up\nwith client []",
          netAmountMinor: cents(100),
        },
      ],
    });
    const line = buildLedes1998b([record]).unwrap().split("\r\n")[2] ?? "";
    expect(line.split("|")).toHaveLength(24);
    expect(line).toContain("Call follow-up with client [ ]");
  });
});

describe("spreadsheets", () => {
  test("summarises one row per invoice in the chosen language", () => {
    const table = buildInvoiceSummaryTable([DOMESTIC_INVOICE], "cs");
    expect(table.headers[0]).toBe("Číslo faktury");
    expect(table.rows[0]?.[15]).toEqual({
      type: "amount",
      amountMinor: 1_833_500,
      currency: "CZK",
    });
  });

  test("lists invoice lines with their work date and timekeeper", () => {
    const table = buildInvoiceLinesTable([DOMESTIC_INVOICE], "en");
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]?.[2]).toEqual({ type: "text", value: "2026-09-12" });
    expect(table.rows[0]?.[13]).toEqual({
      type: "text",
      value: "Jana Nováková",
    });
  });

  test("buckets ESO9 amounts by VAT band and supply type", () => {
    const table = buildEso9Table([MIXED_RATES_INVOICE, EURO_INVOICE]);
    expect(table.headers).toHaveLength(20);
    const [mixed, euro] = table.rows;
    const amount = (cell: InvoiceTableCell | undefined) =>
      cell?.type === "amount" ? cell.amountMinor : undefined;
    expect(amount(mixed?.[5])).toBe(80_000);
    expect(amount(mixed?.[7])).toBe(100_000);
    expect(amount(mixed?.[9])).toBe(50_000);
    // A foreign-currency invoice leaves the home columns to ESO9's rate list.
    expect(euro?.[11]).toEqual({ type: "text", value: "" });
    expect(amount(euro?.[15])).toBe(120_000);
  });

  test("keeps a domestic reverse charge out of the export columns", () => {
    const domestic = {
      ...MIXED_RATES_INVOICE,
      lines: MIXED_RATES_INVOICE.lines.map((line) => ({
        ...line,
        vatTreatment: "reverse_charge" as const,
        vatAmountMinor: cents(0),
      })),
    };
    const [row] = buildEso9Table([domestic]).rows;
    const amount = (cell: InvoiceTableCell | undefined) =>
      cell?.type === "amount" ? cell.amountMinor : undefined;
    expect(amount(row?.[11])).toBe(0);
    expect(amount(row?.[12])).toBe(0);
  });

  test("reads a seller without a country code as Czech", () => {
    const domestic = {
      ...MIXED_RATES_INVOICE,
      seller: { ...MIXED_RATES_INVOICE.seller, country: "Česká republika" },
      buyer: { ...MIXED_RATES_INVOICE.buyer, country: "CZ" },
      lines: MIXED_RATES_INVOICE.lines.map((line) => ({
        ...line,
        vatTreatment: "reverse_charge" as const,
        vatAmountMinor: cents(0),
      })),
    };
    const [row] = buildEso9Table([domestic]).rows;
    const amount = (cell: InvoiceTableCell | undefined) =>
      cell?.type === "amount" ? cell.amountMinor : undefined;
    expect(amount(row?.[11])).toBe(0);
    expect(amount(row?.[12])).toBe(0);
  });
});

describe("client invoice export attribution", () => {
  test("every exported line retains its own matter and the complete invoice total", () => {
    assertProperty(
      "every exported line retains its own matter and the complete invoice total",
      fc.property(
        fc.array(
          fc.record({
            matterIndex: fc.integer({ min: 0, max: 5 }),
            amount: fc.integer({ min: 1, max: 100_000 }),
          }),
          { minLength: 2, maxLength: 30 },
        ),
        (items) => {
          const lines = items.map(({ matterIndex, amount }, index) => ({
            matter: {
              id: `matter-${matterIndex}`,
              name: `Matter ${matterIndex}`,
              reference: `REF-${matterIndex}`,
            },
            description: `Work ${index}`,
            netAmountMinor: cents(amount),
          }));
          const record = exportRecord({
            number: "20260017",
            scope: {
              type: "client",
              clientId: "client",
              matters: [
                ...new Map(
                  lines.map((line) => [line.matter.id, line.matter]),
                ).values(),
              ],
            },
            lines,
          });
          const ledes = buildLedes1998b([record])
            .unwrap()
            .trimEnd()
            .split("\r\n")
            .slice(2);
          const table = buildInvoiceLinesTable([record], "en");
          expect(ledes).toHaveLength(lines.length);
          expect(table.rows).toHaveLength(lines.length);
          for (const [index, line] of lines.entries()) {
            expect(ledes.at(index)?.split("|").at(3)).toBe(
              line.matter.reference,
            );
            expect(ledes.at(index)?.split("|").at(4)).toBe(
              (record.totals.netAmountMinor / 100).toFixed(2),
            );
            expect(table.rows.at(index)?.at(14)).toEqual({
              type: "text",
              value: line.matter.name,
            });
            expect(table.rows.at(index)?.at(15)).toEqual({
              type: "text",
              value: line.matter.reference,
            });
          }
          const summary = buildInvoiceSummaryTable([record], "en");
          expect(summary.rows.at(0)?.at(3)).toEqual({
            type: "text",
            value: [
              ...new Map(
                lines.map((line) => [line.matter.id, line.matter.name]),
              ).values(),
            ].join(", "),
          });
        },
      ),
    );
  });
});
