import { panic, Result } from "better-result";

import { currencyMinorUnitDigits } from "@stll/money";

import { invalidInput, type InvoicingResult } from "../errors";
import { normalizeIban } from "../iban";
import { parseNip } from "../nip";
import type { InvoiceParty } from "../types";
import {
  clip,
  countryCodeOf,
  exportFileNamer,
  invoiceDescriptionOf,
  quantityText,
  streetOf,
  type InvoiceExportLine,
  type InvoiceExportRecord,
} from "./record";
import { el, text, XML_DECLARATION } from "./xml";

// The Polish structured invoice FA(3) (http://crd.gov.pl/wzor/2025/06/25/13775/)
// that KSeF, the national e-invoicing system, accepts. One invoice per file,
// for the seller to send to KSeF itself or through its accounting program.
// Element order follows the schema's sequences; field meanings follow the
// Ministry of Finance's information sheet on the FA(3) logical structure.

const NAMESPACE = "http://crd.gov.pl/wzor/2025/06/25/13775/";

/** The pattern the schema's TNrNIP adds on top of the NIP checksum. */
const NIP_PATTERN = /^[1-9](?:\d[1-9]|[1-9]\d)\d{7}$/u;
const EU_VAT_NUMBER_PATTERN = /^[\dA-Z+*]{1,12}$/u;
const SWIFT_PATTERN = /^[A-Z]{6}[A-Z\d]{2}(?:[A-Z\d]{3})?$/u;

/** EU member states by ISO code; Greece's VAT prefix is EL. */
const EU_COUNTRIES = new Set([
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
]);

const vatPrefixOf = (country: string): string =>
  country === "GR" ? "EL" : country;

/** The EU VAT prefixes (TKodyKrajowUE): the member states with EL for Greece,
 * and XI for Northern Ireland. */
const EU_VAT_PREFIXES = new Set([...[...EU_COUNTRIES].map(vatPrefixOf), "XI"]);

/**
 * The invoice's sales totals, in the schema's order: each net sum (P_13_x)
 * and, for the taxed rates, the VAT on it (P_14_x).
 */
const BUCKETS = {
  basic: { net: "P_13_1", vat: "P_14_1" },
  firstReduced: { net: "P_13_2", vat: "P_14_2" },
  secondReduced: { net: "P_13_3", vat: "P_14_3" },
  zeroDomestic: { net: "P_13_6_1", vat: null },
  exempt: { net: "P_13_7", vat: null },
  outsideCountry: { net: "P_13_8", vat: null },
  euServices: { net: "P_13_9", vat: null },
  domesticReverseCharge: { net: "P_13_10", vat: null },
} as const;

type Bucket = keyof typeof BUCKETS;

/** How one line is taxed: its sum and its P_12 rate code. */
type LineTax = { bucket: Bucket; rate: string };

/** Polish VAT rates: 23 % and 22 % basic, 8 % and 7 % first reduced, 5 %. */
const DOMESTIC_RATES = new Map<number, LineTax>([
  [2300, { bucket: "basic", rate: "23" }],
  [2200, { bucket: "basic", rate: "22" }],
  [800, { bucket: "firstReduced", rate: "8" }],
  [700, { bucket: "firstReduced", rate: "7" }],
  [500, { bucket: "secondReduced", rate: "5" }],
  [0, { bucket: "zeroDomestic", rate: "0 KR" }],
]);

/**
 * The legal basis a seller exempt by turnover cites (art. 113 ust. 1 of the
 * VAT Act); FA(3) requires one whenever P_19 flags exempt sales.
 */
const SMALL_BUSINESS_EXEMPTION = "art. 113 ust. 1 ustawy o VAT";

type BuyerZone = "domestic" | "eu" | "foreign";

/**
 * The tax of a line as FA(3) states it. A reverse charge reads by where the
 * buyer is: domestic reverse charge ("oo"), an EU business customer's
 * services under art. 100 ust. 1 pkt 4 ("np II"), or a supply outside Poland
 * ("np I"). Exempt sales need the exemption's legal basis, which stella does
 * not store, so they are refused.
 */
const lineTaxOf = (
  line: InvoiceExportLine,
  zone: BuyerZone,
): LineTax | string => {
  switch (line.vatTreatment) {
    case "domestic_vat":
      return (
        DOMESTIC_RATES.get(line.vatRateBps) ??
        `${line.vatRateBps / 100} % is not a Polish VAT rate`
      );
    case "not_vat_payer":
      return { bucket: "exempt", rate: "zw" };
    case "exempt":
      return "an exempt line needs the legal basis of the exemption (P_19A), which stella does not store";
    case "outside_scope":
      return { bucket: "outsideCountry", rate: "np I" };
    case "reverse_charge": {
      if (zone === "domestic") {
        return { bucket: "domesticReverseCharge", rate: "oo" };
      }
      return zone === "eu"
        ? { bucket: "euServices", rate: "np II" }
        : { bucket: "outsideCountry", rate: "np I" };
    }
    default: {
      line.vatTreatment satisfies never;
      return panic("Unknown VAT treatment");
    }
  }
};

/**
 * A stored amount as the schema's decimal, digit by digit so no binary
 * fraction creeps in: 123456 minor units of PLN read "1234.56".
 */
const decimalText = (amountMinor: number, digits: number): string => {
  const magnitude = String(Math.abs(amountMinor)).padStart(digits + 1, "0");
  const whole = digits === 0 ? magnitude : magnitude.slice(0, -digits);
  const fraction = digits === 0 ? "" : `.${magnitude.slice(-digits)}`;
  return `${amountMinor < 0 ? "-" : ""}${whole}${fraction}`;
};

/** A Polish NIP without prefix or separators, or null when invalid. */
const polishNipOf = (value: string | undefined): string | null => {
  if (!value?.trim()) {
    return null;
  }
  const nip = parseNip(value);
  return nip !== null && NIP_PATTERN.test(nip) ? nip : null;
};

const presentText = (value: string | undefined): string | null => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
};

/**
 * The buyer's country: its stored code, else its VAT number's prefix, else
 * Poland, where a KSeF invoice's buyer usually is.
 */
const buyerCountryOf = (buyer: InvoiceParty): string => {
  const stored = countryCodeOf(buyer.country);
  if (stored !== null) {
    return stored;
  }
  const prefix = /^([A-Z]{2})/u.exec(
    buyer.vatId?.trim().toUpperCase() ?? "",
  )?.[1];
  if (prefix === "EL") {
    return "GR";
  }
  return prefix !== undefined && EU_COUNTRIES.has(prefix) ? prefix : "PL";
};

const zoneOf = (country: string): BuyerZone => {
  if (country === "PL") {
    return "domestic";
  }
  return EU_COUNTRIES.has(country) ? "eu" : "foreign";
};

/** Street, then postal code and town, as the schema's two address lines. */
const address = (party: InvoiceParty, country: string): string => {
  const street = streetOf(party);
  const town = [party.postalCode, party.city]
    .map((part) => part?.trim() ?? "")
    .filter((part) => part !== "")
    .join(" ");
  const first = street === "" ? town : street;
  return el("Adres", [
    text("KodKraju", country),
    text("AdresL1", clip(first, 512)),
    text("AdresL2", street === "" ? null : clip(town, 512)),
  ]);
};

const hasAddress = (party: InvoiceParty): boolean =>
  [party.addressLine1, party.addressLine2, party.postalCode, party.city].some(
    (part) => presentText(part) !== null,
  );

/**
 * Podmiot2's identification. A Polish buyer is named by NIP, which KSeF
 * delivers the invoice by; an EU business by VAT number; anyone else by its
 * own tax identifier; a buyer with none (a consumer) by BrakID.
 */
const buyerIdentification = (
  buyer: InvoiceParty,
  country: string,
  needsEuVatNumber: boolean,
): string | { error: string } => {
  const zone = zoneOf(country);
  const identifier = presentText(buyer.vatId) ?? presentText(buyer.taxId);
  const name = text("Nazwa", clip(buyer.name.trim(), 512));
  const vatId = presentText(buyer.vatId)
    ?.replaceAll(/[^\dA-Za-z+*]/gu, "")
    .toUpperCase();
  // The VAT registration identifies the taxpayer, so its own prefix decides
  // before the address does: a German registration at a Polish address is an
  // EU buyer, a PL-prefixed NIP at a foreign address a Polish one. Leading
  // letters that are not a prefix belong to the number (French numbers).
  const leading = vatId?.slice(0, 2) ?? "";
  const ownPrefix = EU_VAT_PREFIXES.has(leading) ? leading : undefined;
  const euVat = (prefix: string, number: string) =>
    EU_VAT_NUMBER_PATTERN.test(number)
      ? [text("KodUE", prefix), text("NrVatUE", number), name].join("")
      : { error: `the buyer's EU VAT number ${vatId ?? ""} is not valid` };
  if (vatId && ownPrefix !== undefined && ownPrefix !== "PL") {
    return euVat(ownPrefix, vatId.slice(2));
  }
  if (zone === "domestic" || ownPrefix === "PL") {
    if (identifier === null) {
      return [text("BrakID", "1"), name].join("");
    }
    const nip = polishNipOf(identifier);
    return nip === null
      ? { error: `the buyer's NIP ${identifier} is not a valid Polish NIP` }
      : [text("NIP", nip), name].join("");
  }
  if (zone === "eu" && vatId) {
    return euVat(vatPrefixOf(country), vatId);
  }
  if (needsEuVatNumber) {
    return {
      error:
        "a reverse-charge service to an EU buyer needs the buyer's EU VAT number",
    };
  }
  if (identifier === null) {
    return [text("BrakID", "1"), name].join("");
  }
  return [
    text("KodKraju", country),
    text("NrID", clip(identifier.replaceAll(/\s/gu, ""), 50)),
    name,
  ].join("");
};

/** Polish accounts as the 26-digit NRB; foreign ones as the full IBAN. */
const accountNumberOf = (iban: string): string =>
  iban.startsWith("PL") ? iban.slice(2) : iban;

type Classified = { line: InvoiceExportLine; tax: LineTax };

const document = (
  record: InvoiceExportRecord,
  context: {
    sellerNip: string;
    buyerCountry: string;
    buyerIdentification: string;
    lines: readonly Classified[];
    iban: string | null;
    generatedAt: string;
  },
): string => {
  const digits = currencyMinorUnitDigits(record.currency);
  const amount = (value: number) => decimalText(value, digits);
  const { lines } = context;
  const sums = new Map<string, { net: number; vat: number }>();
  for (const { line, tax } of lines) {
    const sum = sums.get(tax.bucket) ?? { net: 0, vat: 0 };
    sum.net += line.netAmountMinor;
    sum.vat += line.vatAmountMinor;
    sums.set(tax.bucket, sum);
  }
  const totals = Object.entries(BUCKETS).flatMap(([bucket, fields]) => {
    const sum = sums.get(bucket);
    if (sum === undefined) {
      return [];
    }
    return [
      text(fields.net, amount(sum.net)),
      fields.vat === null ? "" : text(fields.vat, amount(sum.vat)),
    ];
  });
  const exempt = sums.has("exempt");
  const reverseCharge = lines.some(
    ({ line }) => line.vatTreatment === "reverse_charge",
  );
  const advance = record.documentType === "advance";
  // The tax point: the supply date, or for an advance the day it was paid.
  const supplyDate = advance
    ? (record.paidDate ?? record.taxableSupplyDate)
    : record.taxableSupplyDate;
  const seller = record.seller;
  const swift = seller.bic?.replaceAll(/\s/gu, "").toUpperCase() ?? "";
  // Zaplacono/DataZaplaty state a payment made by the time the invoice is
  // issued; a later payment does not change the invoice.
  const paidByIssue =
    record.paidDate !== null && record.paidDate <= record.issueDate;
  const payment = el("Platnosc", [
    paidByIssue
      ? [text("Zaplacono", "1"), text("DataZaplaty", record.paidDate)]
      : "",
    record.dueDate ? el("TerminPlatnosci", text("Termin", record.dueDate)) : "",
    context.iban ? text("FormaPlatnosci", "6") : "",
    context.iban
      ? el("RachunekBankowy", [
          text("NrRB", accountNumberOf(context.iban)),
          SWIFT_PATTERN.test(swift) ? text("SWIFT", swift) : "",
        ])
      : "",
  ]);
  const unitPrice = (line: InvoiceExportLine) =>
    amount(line.unitPriceMinor ?? line.netAmountMinor);
  const invoiceLines = advance
    ? ""
    : lines.map(({ line, tax }, index) =>
        el("FaWiersz", [
          text("NrWierszaFa", String(index + 1)),
          text("P_7", clip(line.description.trim(), 512)),
          text("P_8A", line.unit === null ? null : clip(line.unit.trim(), 256)),
          text("P_8B", quantityText(line.quantity)),
          text("P_9A", unitPrice(line)),
          text("P_11", amount(line.netAmountMinor)),
          // stella rounds VAT per line (art. 106e ust. 10 of the VAT Act).
          line.vatTreatment === "domestic_vat"
            ? text("P_11Vat", amount(line.vatAmountMinor))
            : "",
          text("P_12", tax.rate),
        ]),
      );
  // An advance invoice states the order it is paid towards (art. 106f
  // ust. 1 pkt 4); stella knows the order as the advance's own lines.
  const order = advance
    ? el("Zamowienie", [
        text("WartoscZamowienia", amount(record.totals.grossAmountMinor)),
        lines.map(({ line, tax }, index) =>
          el("ZamowienieWiersz", [
            text("NrWierszaZam", String(index + 1)),
            text("P_7Z", clip(line.description.trim(), 512)),
            text(
              "P_8AZ",
              line.unit === null ? null : clip(line.unit.trim(), 256),
            ),
            text("P_8BZ", quantityText(line.quantity)),
            text("P_9AZ", unitPrice(line)),
            text("P_11NettoZ", amount(line.netAmountMinor)),
            line.vatTreatment === "domestic_vat"
              ? text("P_11VatZ", amount(line.vatAmountMinor))
              : "",
            text("P_12Z", tax.rate),
          ]),
        ),
      ])
    : "";
  const description = invoiceDescriptionOf(record);
  const body = [
    el("Naglowek", [
      text("KodFormularza", "FA", {
        kodSystemowy: "FA (3)",
        wersjaSchemy: "1-0E",
      }),
      text("WariantFormularza", "3"),
      text("DataWytworzeniaFa", context.generatedAt),
      text("SystemInfo", "stella"),
    ]),
    el("Podmiot1", [
      // The seller's EU VAT prefix, which art. 106e ust. 1 pkt 24 asks for
      // on services to an EU business.
      sums.has("euServices") ? text("PrefiksPodatnika", "PL") : "",
      el("DaneIdentyfikacyjne", [
        text("NIP", context.sellerNip),
        text("Nazwa", clip(seller.name.trim(), 512)),
      ]),
      address(seller, countryCodeOf(seller.country) ?? "PL"),
    ]),
    el("Podmiot2", [
      el("DaneIdentyfikacyjne", context.buyerIdentification),
      address(record.buyer, context.buyerCountry),
      // stella bills no subordinate local-government units or VAT groups.
      text("JST", "2"),
      text("GV", "2"),
    ]),
    el("Fa", [
      text("KodWaluty", record.currency),
      text("P_1", record.issueDate),
      text("P_2", record.number),
      text("P_6", supplyDate),
      ...totals,
      text("P_15", amount(record.totals.grossAmountMinor)),
      el("Adnotacje", [
        text("P_16", "2"),
        text("P_17", "2"),
        text("P_18", reverseCharge ? "1" : "2"),
        text("P_18A", "2"),
        el(
          "Zwolnienie",
          exempt
            ? [text("P_19", "1"), text("P_19A", SMALL_BUSINESS_EXEMPTION)]
            : text("P_19N", "1"),
        ),
        el("NoweSrodkiTransportu", text("P_22N", "1")),
        text("P_23", "2"),
        el("PMarzy", text("P_PMarzyN", "1")),
      ]),
      text("RodzajFaktury", advance ? "ZAL" : "VAT"),
      invoiceLines,
      payment,
      order,
    ]),
    description === null
      ? ""
      : el(
          "Stopka",
          el("Informacje", text("StopkaFaktury", clip(description, 3500))),
        ),
  ];
  return `${XML_DECLARATION}${el("Faktura", body, { xmlns: NAMESPACE })}\n`;
};

/** Every reason one record cannot be a valid FA(3) invoice, or its data. */
const prepare = (
  record: InvoiceExportRecord,
  generatedAt: string,
): InvoicingResult<string> => {
  const refuse = (reason: string) =>
    invalidInput(`Invoice ${record.number}: ${reason}`);
  if (record.documentType === "credit_note") {
    // A correction (KOR) must name the corrected invoice's issue date and
    // its KSeF number, or state that it was issued outside KSeF.
    return refuse(
      "a KSeF corrective invoice needs the corrected invoice's issue date and KSeF number, which stella does not store",
    );
  }
  const digits = currencyMinorUnitDigits(record.currency);
  if (digits > 2) {
    return refuse(
      `FA(3) states amounts to two decimals; ${record.currency} has ${digits}`,
    );
  }
  if (record.lines.length === 0) {
    return refuse("the invoice has no lines");
  }
  const sellerNip =
    polishNipOf(record.seller.vatId) ?? polishNipOf(record.seller.taxId);
  if (sellerNip === null) {
    return refuse(
      "the seller has no valid Polish NIP; KSeF identifies the issuer by NIP",
    );
  }
  if (record.seller.name.trim() === "" || !hasAddress(record.seller)) {
    return refuse("FA(3) requires the seller's name and address");
  }
  if (!hasAddress(record.buyer)) {
    return refuse("FA(3) requires the buyer's address");
  }
  const notVatPayer = record.lines.filter(
    (line) => line.vatTreatment === "not_vat_payer",
  ).length;
  if (notVatPayer > 0 && notVatPayer < record.lines.length) {
    return refuse(
      "a seller exempt from VAT cannot also charge or reverse-charge VAT on the same invoice",
    );
  }
  const buyerCountry = buyerCountryOf(record.buyer);
  const zone = zoneOf(buyerCountry);
  const lines: Classified[] = [];
  for (const line of record.lines) {
    const tax = lineTaxOf(line, zone);
    if (typeof tax === "string") {
      return refuse(`line ${line.position}: ${tax}`);
    }
    lines.push({ line, tax });
  }
  if (
    record.currency !== "PLN" &&
    lines.some(({ tax }) => BUCKETS[tax.bucket].vat !== null)
  ) {
    return refuse(
      `VAT on an invoice in ${record.currency} must also be stated in PLN at the exchange rate of the day before the tax point, which stella does not store`,
    );
  }
  const identification = buyerIdentification(
    record.buyer,
    buyerCountry,
    lines.some(({ tax }) => tax.bucket === "euServices"),
  );
  if (typeof identification !== "string") {
    return refuse(identification.error);
  }
  let iban: string | null = null;
  if (presentText(record.seller.iban) !== null) {
    iban = normalizeIban(record.seller.iban ?? "");
    if (iban === null) {
      return refuse("the seller's IBAN is not valid");
    }
  }
  return Result.ok(
    document(record, {
      sellerNip,
      buyerCountry,
      buyerIdentification: identification,
      lines,
      iban,
      generatedAt,
    }),
  );
};

/**
 * One FA(3) invoice per record, keyed by file name, for the seller to send
 * to KSeF. Invoices and advance invoices are written; a credit note, an
 * exempt line or VAT in a foreign currency need data stella does not keep,
 * and an invoice without a valid Polish NIP for the seller cannot be
 * issued in KSeF, so those are refused.
 */
export const buildKsefFa3Files = (
  records: readonly InvoiceExportRecord[],
  generatedAt: Date,
): InvoicingResult<{ fileName: string; content: string }[]> => {
  if (records.length === 0) {
    return invalidInput("There are no issued invoices to export");
  }
  const timestamp = generatedAt.toISOString().replace(/\.\d{3}Z$/u, "Z");
  const fileName = exportFileNamer("xml");
  const files: { fileName: string; content: string }[] = [];
  for (const record of records) {
    const content = prepare(record, timestamp);
    if (content.isErr()) {
      return Result.err(content.error);
    }
    files.push({
      fileName: fileName(record.number),
      content: content.value,
    });
  }
  return Result.ok(files);
};
