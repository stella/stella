import type { EInvoice } from "@stll/api-contract/e-invoice";

import type { DocumentXmlNode } from "@/api/lib/files/xml-document-package";

/**
 * Readers for one invoice syntax's element tree. Elements are found by local
 * name: each syntax's own namespaces are fixed by the root it was routed by,
 * and FatturaPA's children are unqualified.
 */

/** The preview's line cap; the invoice's own line count is kept beside it. */
export const E_INVOICE_PREVIEW_MAX_LINES = 1000;

export const childrenOf = (
  node: DocumentXmlNode | undefined,
  name: string,
): DocumentXmlNode[] =>
  node === undefined
    ? []
    : node.children.filter(({ localName }) => localName === name);

export const at = (
  node: DocumentXmlNode | undefined,
  ...path: string[]
): DocumentXmlNode | undefined => {
  let current = node;
  for (const name of path) {
    current = current?.children.find(({ localName }) => localName === name);
  }
  return current;
};

/** Longest stated value a preview keeps; invoice fields are far shorter. */
const E_INVOICE_MAX_VALUE_CHARS = 10_000;

/** A stated value: the element's own text, trimmed, or null when empty. */
export const textOf = (node: DocumentXmlNode | undefined): string | null => {
  const text = node?.text
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, E_INVOICE_MAX_VALUE_CHARS);
  return text || null;
};

export const textAt = (
  node: DocumentXmlNode | undefined,
  ...path: string[]
): string | null => textOf(at(node, ...path));

export const attributeOf = (
  node: DocumentXmlNode | undefined,
  name: string,
): string | null => node?.attributes.get(name)?.trim() || null;

/** Non-empty values joined, or null when none is stated. */
export const joined = (
  separator: string,
  ...values: (string | null)[]
): string | null => {
  const present = values.filter((value) => value !== null);
  return present.length > 0 ? present.join(separator) : null;
};

export const addressLines = (...lines: (string | null)[]): string[] =>
  lines.filter((line) => line !== null);

/** A stated quantity with its unit code ("100", "C62"). */
export const statedQuantity = (
  node: DocumentXmlNode | undefined,
): { quantity: string; unitCode: string | null } | null => {
  const quantity = textOf(node);
  return quantity === null
    ? null
    : { quantity, unitCode: attributeOf(node, "unitCode") };
};

type Party = EInvoice["seller"];
type PartyIdentifier = Party["identifiers"][number];

/** The more specific a kind, the earlier: a VAT id is more than "other". */
const KIND_RANK = {
  vat: 0,
  tax: 1,
  registration: 2,
  other: 3,
} as const satisfies Record<PartyIdentifier["kind"], number>;

/** An identifier's value apart from case and spacing. */
const writtenKey = (value: string) => value.replace(/\s/gu, "").toUpperCase();

/**
 * Whether two identifiers state the same value. A VAT or tax number's dots
 * and dashes are formatting ("0123.456.789"), so two such numbers match
 * without them; any other identifier (an address, an opaque code such as
 * `A-1`) keeps its punctuation.
 */
const sameIdentifier = (left: PartyIdentifier, right: PartyIdentifier) => {
  const leftKey = writtenKey(left.value);
  const rightKey = writtenKey(right.value);
  if (leftKey === rightKey) {
    return true;
  }
  const isNumber = (kind: PartyIdentifier["kind"]) =>
    kind === "vat" || kind === "tax";
  const digitsOnly = (key: string) => key.replace(/[.-]/gu, "");
  return (
    isNumber(left.kind) &&
    isNumber(right.kind) &&
    digitsOnly(leftKey) === digitsOnly(rightKey)
  );
};

/**
 * A party's identifiers, each value once. A file often states one number in
 * two places (the VAT number, and the electronic address in the VAT
 * scheme); it is listed where the first one stood, under the more specific
 * of the two kinds.
 */
const distinctIdentifiers = (
  identifiers: readonly PartyIdentifier[],
): PartyIdentifier[] => {
  const listed: PartyIdentifier[] = [];
  for (const identifier of identifiers) {
    const index = listed.findIndex((known) =>
      sameIdentifier(known, identifier),
    );
    const known = index === -1 ? undefined : listed[index];
    if (known === undefined) {
      listed.push(identifier);
    } else if (KIND_RANK[identifier.kind] < KIND_RANK[known.kind]) {
      listed[index] = { ...identifier, value: known.value };
    }
  }
  return listed;
};

/** The party with each identifier listed once. */
export const withDistinctIdentifiers = (party: Party): Party => ({
  ...party,
  identifiers: distinctIdentifiers(party.identifiers),
});

// ISO 13616: two letters, two check digits, then up to 30 letters or digits.
const IBAN_SHAPE = /^[A-Z]{2}\d{2}[A-Z\d]{11,30}$/u;

/** Whether an account identifier is written as an IBAN, spaces aside. */
export const isIbanShaped = (value: string): boolean =>
  IBAN_SHAPE.test(value.replace(/\s+/gu, "").toUpperCase());

/** The stated values of a list, in order, without the empty ones. */
export const statedValues = (values: (string | null)[]): string[] =>
  values.filter((value) => value !== null);

/** The first value of a list in which amounts may carry a currency each. */
export const amountInCurrency = (
  nodes: DocumentXmlNode[],
  currency: string | null,
): string | null =>
  textOf(
    nodes.find((node) => attributeOf(node, "currencyID") === currency) ??
      nodes[0],
  );

export const capLines = (lines: EInvoice["lines"]) =>
  lines.slice(0, E_INVOICE_PREVIEW_MAX_LINES);

/** UN/EDIFACT 1001 invoice type codes, as EN 16931 uses them (BT-3). */
export const documentTypeFromUnCode = (
  code: string | null,
): EInvoice["documentType"] => {
  // The code is optional in UBL, where the document is then an invoice.
  if (code === null) {
    return "invoice";
  }
  switch (code) {
    case "380":
    case "384":
    case "389":
    case "751":
      return "invoice";
    case "381":
    case "261":
    case "396":
      return "creditNote";
    case "383":
      return "debitNote";
    case "386":
      return "advance";
    default:
      return "other";
  }
};

/** An embedded file stated as base64 text. */
export type EmbeddedInvoiceFile = {
  fileName: string;
  description: string | null;
  base64: string;
};

export type ParsedEInvoice = {
  version: string | null;
  invoices: EInvoice[];
  embedded: EmbeddedInvoiceFile[];
};
