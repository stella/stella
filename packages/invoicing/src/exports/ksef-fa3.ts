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
  type InvoiceExportLine,
  type InvoiceExportRecord,
  quantityText,
  streetOf,
} from "./record";
import { el, text, XML_DECLARATION } from "./xml";

// The Polish structured invoice FA(3) (http://crd.gov.pl/wzor/2025/06/25/13775/)
// that KSeF, the national e-invoicing system, accepts. One invoice per file,
// for the seller to send to KSeF itself or through its accounting program.
// Element order follows the schema's sequences; field meanings follow the
// Ministry of Finance's information sheet on the FA(3) logical structure.

const NAMESPACE = "http://crd.gov.pl/wzor/2025/06/25/13775/";

/** Canonical form code shared by the FA(3) serializer and KSeF transport. */
export const KSEF_FA3_FORM_CODE = {
  systemCode: "FA (3)",
  schemaVersion: "1-0E",
  value: "FA",
} as const;

/** The pattern the schema's TNrNIP adds on top of the NIP checksum. */
const NIP_PATTERN = /^[1-9](?:\d[1-9]|[1-9]\d)\d{7}$/u;
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

type EuCountry =
  | "AT"
  | "BE"
  | "BG"
  | "CY"
  | "CZ"
  | "DE"
  | "DK"
  | "EE"
  | "ES"
  | "FI"
  | "FR"
  | "GR"
  | "HR"
  | "HU"
  | "IE"
  | "IT"
  | "LT"
  | "LU"
  | "LV"
  | "MT"
  | "NL"
  | "PL"
  | "PT"
  | "RO"
  | "SE"
  | "SI"
  | "SK";

/** VAT-number shapes after removing the registration country's prefix. */
const EU_VAT_NUMBER_PATTERNS = {
  AT: /^U\d{8}$/u,
  BE: /^\d{10}$/u,
  BG: /^\d{9,10}$/u,
  CY: /^\d{8}[A-Z]$/u,
  CZ: /^\d{8,10}$/u,
  DE: /^\d{9}$/u,
  DK: /^\d{8}$/u,
  EE: /^\d{9}$/u,
  ES: /^[A-Z\d]\d{7}[A-Z\d]$/u,
  FI: /^\d{8}$/u,
  FR: /^[A-Z\d]{2}\d{9}$/u,
  GR: /^\d{9}$/u,
  HR: /^\d{11}$/u,
  HU: /^\d{8}$/u,
  IE: /^(?:\d{7}[A-Z]{1,2}|\d[A-Z\d+*]\d{5}[A-Z])$/u,
  IT: /^\d{11}$/u,
  LT: /^(?:\d{9}|\d{12})$/u,
  LU: /^\d{8}$/u,
  LV: /^\d{11}$/u,
  MT: /^\d{8}$/u,
  NL: /^\d{9}B\d{2}$/u,
  PL: /^\d{10}$/u,
  PT: /^\d{9}$/u,
  RO: /^\d{2,10}$/u,
  SE: /^\d{12}$/u,
  SI: /^\d{8}$/u,
  SK: /^\d{10}$/u,
} as const satisfies Record<EuCountry, RegExp>;

const vatPrefixOf = (country: string): string =>
  country === "GR" ? "EL" : country;

/** Northern Ireland's VAT prefix: it is in the EU VAT area for goods only
 * (Windsor Framework), so a service to an XI registration is supplied outside
 * the EU, like one to Great Britain. */
const NORTHERN_IRELAND_PREFIX = "XI";

/** Each EU VAT prefix (TKodyKrajowUE) with its number shape: the member states
 * with EL for Greece, and XI for Northern Ireland. */
const VAT_NUMBER_PATTERN_BY_PREFIX: ReadonlyMap<string, RegExp> = new Map([
  ...Object.entries(EU_VAT_NUMBER_PATTERNS).map(
    ([country, pattern]) => [vatPrefixOf(country), pattern] as const,
  ),
  [NORTHERN_IRELAND_PREFIX, /^(?:\d{9}|\d{12}|GD\d{3}|HA\d{3})$/u],
]);

const EU_VAT_PREFIXES: ReadonlySet<string> = new Set(
  VAT_NUMBER_PATTERN_BY_PREFIX.keys(),
);

/**
 * The invoice's sales totals, in the schema's order: each net sum (P_13_x)
 * and, for the taxed rates, the VAT on it (P_14_x).
 */
const BUCKETS = {
  basic: { net: "P_13_1", vat: "P_14_1" },
  firstReduced: { net: "P_13_2", vat: "P_14_2" },
  secondReduced: { net: "P_13_3", vat: "P_14_3" },
  zeroDomestic: { net: "P_13_6_1", vat: null },
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

type BuyerTaxIdentity =
  | { zone: "domestic"; nip: string | null }
  | { zone: "eu"; prefix: string; number: string }
  | { zone: "foreign"; country: string; identifier: string | null };

/**
 * The tax of a line as FA(3) states it. A reverse charge reads by where the
 * buyer is: domestic reverse charge ("oo"), an EU business customer's
 * services under art. 100 ust. 1 pkt 4 ("np II"), or a supply outside Poland
 * ("np I"). Exempt sales, a seller outside VAT included, need the exemption's
 * legal basis, which stella does not store, so they are refused.
 */
const lineTaxOf = (
  line: InvoiceExportLine,
  identity: BuyerTaxIdentity,
): LineTax | string => {
  switch (line.vatTreatment) {
    case "domestic_vat":
      return (
        DOMESTIC_RATES.get(line.vatRateBps) ??
        `${line.vatRateBps / 100} % is not a Polish VAT rate`
      );
    // FA(3) states the legal basis of every exemption (P_19A). Being outside
    // VAT does not establish one: art. 113 ust. 13 pkt 2 lit. a excludes legal
    // services from the small-business exemption.
    case "not_vat_payer":
    case "exempt":
      return "an exempt line needs the legal basis of the exemption (P_19A), which stella does not store";
    case "outside_scope":
      return { bucket: "outsideCountry", rate: "np I" };
    case "reverse_charge":
      switch (identity.zone) {
        case "domestic":
          return { bucket: "domesticReverseCharge", rate: "oo" };
        case "eu":
          return identity.prefix === NORTHERN_IRELAND_PREFIX
            ? { bucket: "outsideCountry", rate: "np I" }
            : { bucket: "euServices", rate: "np II" };
        case "foreign":
          return { bucket: "outsideCountry", rate: "np I" };
        default: {
          identity satisfies never;
          return panic("Unknown buyer tax identity");
        }
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

/** FA(3) unit amounts carry up to eight decimals (TKwotowy2). */
const UNIT_PRICE_DIGITS = 8;

/** A decimal scaled by 10^scale, keeping at least `minimum` decimals. */
const scaledDecimalText = (
  scaled: bigint,
  { scale, minimum }: { scale: number; minimum: number },
): string => {
  const negative = scaled < 0n;
  const magnitude = (negative ? -scaled : scaled)
    .toString()
    .padStart(scale + 1, "0");
  let fraction = magnitude.slice(-scale);
  while (fraction.length > minimum && fraction.endsWith("0")) {
    fraction = fraction.slice(0, -1);
  }
  return `${negative ? "-" : ""}${magnitude.slice(0, -scale)}${fraction === "" ? "" : `.${fraction}`}`;
};

/**
 * The net unit price every line of an ordinary invoice states (art. 106e
 * ust. 1 pkt 9 of the VAT Act): the stored one, else the net amount divided by
 * the quantity when that division is exact to eight decimals; null otherwise.
 */
const unitPriceTextOf = (
  line: InvoiceExportLine,
  digits: number,
): string | null => {
  if (line.unitPriceMinor !== null) {
    return decimalText(line.unitPriceMinor, digits);
  }
  const match = /^(-?\d+)(?:\.(\d+))?$/u.exec(line.quantity ?? "1");
  if (!match) {
    return null;
  }
  const fraction = match[2] ?? "";
  const quantityUnits = BigInt(`${match[1] ?? ""}${fraction}`);
  if (quantityUnits === 0n) {
    return null;
  }
  const numerator =
    BigInt(line.netAmountMinor) *
    10n ** BigInt(fraction.length + UNIT_PRICE_DIGITS);
  const denominator = quantityUnits * 10n ** BigInt(digits);
  if (numerator % denominator !== 0n) {
    return null;
  }
  return scaledDecimalText(numerator / denominator, {
    scale: UNIT_PRICE_DIGITS,
    minimum: digits,
  });
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

/** The buyer's address country, with a VAT-prefix fallback for missing data. */
const buyerAddressCountryOf = (buyer: InvoiceParty): string => {
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
const buyerTaxIdentity = (
  buyer: InvoiceParty,
  country: string,
  needsEuVatNumber: boolean,
): BuyerTaxIdentity | { error: string } => {
  const identifier = presentText(buyer.vatId) ?? presentText(buyer.taxId);
  const vatId = presentText(buyer.vatId)
    ?.replaceAll(/[^\dA-Za-z+*]/gu, "")
    .toUpperCase();
  // The VAT registration identifies the taxpayer, so its own prefix decides
  // before the address does: a German registration at a Polish address is an
  // EU buyer, a PL-prefixed NIP at a foreign address a Polish one. Leading
  // letters that are not a prefix belong to the number (French numbers).
  const leading = vatId?.slice(0, 2) ?? "";
  const ownPrefix = EU_VAT_PREFIXES.has(leading) ? leading : undefined;
  const euVat = (
    prefix: string,
    number: string,
  ): BuyerTaxIdentity | { error: string } =>
    VAT_NUMBER_PATTERN_BY_PREFIX.get(prefix)?.test(number) === true
      ? { zone: "eu", prefix, number }
      : { error: `the buyer's EU VAT number ${vatId ?? ""} is not valid` };
  if (vatId && ownPrefix !== undefined && ownPrefix !== "PL") {
    return euVat(ownPrefix, vatId.slice(2));
  }
  if (country === "PL" || ownPrefix === "PL") {
    if (identifier === null) {
      return { zone: "domestic", nip: null };
    }
    const nip = polishNipOf(identifier);
    return nip === null
      ? { error: `the buyer's NIP ${identifier} is not a valid Polish NIP` }
      : { zone: "domestic", nip };
  }
  if (EU_COUNTRIES.has(country) && vatId) {
    return euVat(vatPrefixOf(country), vatId);
  }
  if (EU_COUNTRIES.has(country) && needsEuVatNumber) {
    return {
      error:
        "a reverse-charge service to an EU buyer needs the buyer's EU VAT number",
    };
  }
  return { zone: "foreign", country, identifier };
};

const buyerIdentification = (
  buyer: InvoiceParty,
  identity: BuyerTaxIdentity,
): string => {
  const name = text("Nazwa", clip(buyer.name.trim(), 512));
  switch (identity.zone) {
    case "domestic":
      return [
        identity.nip === null ? text("BrakID", "1") : text("NIP", identity.nip),
        name,
      ].join("");
    case "eu":
      return [
        text("KodUE", identity.prefix),
        text("NrVatUE", identity.number),
        name,
      ].join("");
    case "foreign":
      return identity.identifier === null
        ? [text("BrakID", "1"), name].join("")
        : [
            text("KodKraju", identity.country),
            text("NrID", clip(identity.identifier.replaceAll(/\s/gu, ""), 50)),
            name,
          ].join("");
    default: {
      identity satisfies never;
      return panic("Unknown buyer tax identity");
    }
  }
};

/** Polish accounts as the 26-digit NRB; foreign ones as the full IBAN. */
const accountNumberOf = (iban: string): string =>
  iban.startsWith("PL") ? iban.slice(2) : iban;

type Classified = { line: InvoiceExportLine; tax: LineTax; unitPrice: string };

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
  const reverseCharge = lines.some(
    ({ line }) => line.vatTreatment === "reverse_charge",
  );
  const supplyDate = record.taxableSupplyDate;
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
  const invoiceLines = lines.map(({ line, tax, unitPrice }, index) =>
    el("FaWiersz", [
      text("NrWierszaFa", String(index + 1)),
      text("P_7", clip(line.description.trim(), 512)),
      text("P_8A", line.unit === null ? null : clip(line.unit.trim(), 256)),
      text("P_8B", quantityText(line.quantity)),
      text("P_9A", unitPrice),
      text("P_11", amount(line.netAmountMinor)),
      // stella rounds VAT per line (art. 106e ust. 10 of the VAT Act).
      line.vatTreatment === "domestic_vat"
        ? text("P_11Vat", amount(line.vatAmountMinor))
        : "",
      text("P_12", tax.rate),
    ]),
  );
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
        el("Zwolnienie", text("P_19N", "1")),
        el("NoweSrodkiTransportu", text("P_22N", "1")),
        text("P_23", "2"),
        el("PMarzy", text("P_PMarzyN", "1")),
      ]),
      text("RodzajFaktury", "VAT"),
      invoiceLines,
      payment,
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
  if (record.documentType === "advance") {
    // ZAL must state the whole order or contract under art. 106f ust. 1 pkt 4.
    return refuse(
      "an advance invoice needs the value and lines of the order it is paid towards, which stella does not store",
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
  const buyerCountry = buyerAddressCountryOf(record.buyer);
  const identity = buyerTaxIdentity(
    record.buyer,
    buyerCountry,
    record.lines.some((line) => line.vatTreatment === "reverse_charge"),
  );
  if ("error" in identity) {
    return refuse(identity.error);
  }
  const lines: Classified[] = [];
  for (const line of record.lines) {
    const tax = lineTaxOf(line, identity);
    if (typeof tax === "string") {
      return refuse(`line ${line.position}: ${tax}`);
    }
    const unitPrice = unitPriceTextOf(line, digits);
    if (unitPrice === null) {
      return refuse(
        `line ${line.position}: an invoice line states its net unit price (art. 106e ust. 1 pkt 9); stella stores none and the net amount does not divide exactly by the quantity`,
      );
    }
    lines.push({ line, tax, unitPrice });
  }
  if (
    record.currency !== "PLN" &&
    lines.some(({ tax }) => BUCKETS[tax.bucket].vat !== null)
  ) {
    return refuse(
      `VAT on an invoice in ${record.currency} must also be stated in PLN at the exchange rate of the day before the tax point, which stella does not store`,
    );
  }
  const identification = buyerIdentification(record.buyer, identity);
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
 * to KSeF. Advance invoices, credit notes, exempt lines and VAT in a foreign
 * currency need data stella does not keep,
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
