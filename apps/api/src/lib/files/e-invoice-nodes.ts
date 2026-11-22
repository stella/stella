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

/** A stated quantity with its unit code, as "100 C62". */
export const quantityWithUnit = (
  node: DocumentXmlNode | undefined,
): string | null => {
  const quantity = textOf(node);
  return quantity === null
    ? null
    : joined(" ", quantity, attributeOf(node, "unitCode"));
};

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

/** Bytes a base64 text decodes to, without decoding it. */
export const base64DecodedSize = (base64: string): number => {
  const compact = base64.replace(/[^A-Za-z0-9+/=_-]/gu, "");
  let padding = 0;
  if (compact.endsWith("==")) {
    padding = 2;
  } else if (compact.endsWith("=")) {
    padding = 1;
  }
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
};

export type ParsedEInvoice = {
  version: string | null;
  invoices: EInvoice[];
  embedded: EmbeddedInvoiceFile[];
};
