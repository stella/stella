import type { DocumentXmlNode } from "@/api/lib/files/xml-document-package";

/**
 * What an XML file is, decided only by its root element's name and namespace.
 * Every reader of `.xml` content routes through this one table, so two readers
 * can never claim the same file and an unlisted root stays plain XML.
 *
 * - ISDOC 6.x (`http://isdoc.cz/namespace/2013`) and ISDOC 5.x.
 * - FatturaPA 1.x ordinary invoices (`FatturaElettronica`), as published by
 *   the Agenzia delle Entrate, and the earlier fatturapa.gov.it namespaces.
 * - EN 16931 syntax bindings (CEN/TS 16931-3): UBL 2.1 Invoice and CreditNote
 *   (3-2) and UN/CEFACT Cross Industry Invoice D16B (3-3).
 * - XML signatures (XMLDSig `Signature`, ETSI `XAdESSignatures`) are not
 *   documents; they are listed so no document reader ever takes one.
 */
const XML_DOCUMENT_ROOTS = [
  {
    documentClass: "isdoc",
    localName: "Invoice",
    namespaces: [
      "http://isdoc.cz/namespace/2013",
      "http://isdoc.cz/namespace/invoice",
    ],
  },
  {
    documentClass: "fatturaPA",
    localName: "FatturaElettronica",
    namespaces: [
      "http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2",
      "http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.1",
      "http://www.fatturapa.gov.it/sdi/fatturapa/v1.1",
      "http://www.fatturapa.gov.it/sdi/fatturapa/v1.0",
    ],
  },
  {
    documentClass: "ubl",
    localName: "Invoice",
    namespaces: ["urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"],
  },
  {
    documentClass: "ubl",
    localName: "CreditNote",
    namespaces: ["urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"],
  },
  {
    documentClass: "cii",
    localName: "CrossIndustryInvoice",
    namespaces: [
      "urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100",
    ],
  },
  {
    documentClass: "xmlSignature",
    localName: "Signature",
    namespaces: ["http://www.w3.org/2000/09/xmldsig#"],
  },
  {
    documentClass: "xmlSignature",
    localName: "XAdESSignatures",
    namespaces: ["http://uri.etsi.org/02918/v1.2.1#"],
  },
] as const;

export type XmlDocumentClass =
  (typeof XML_DOCUMENT_ROOTS)[number]["documentClass"];

export const classifyXmlDocument = (
  root: Pick<DocumentXmlNode, "localName" | "namespaceURI">,
): XmlDocumentClass | null =>
  XML_DOCUMENT_ROOTS.find(
    ({ localName, namespaces }) =>
      root.localName === localName &&
      namespaces.some((namespace) => namespace === root.namespaceURI),
  )?.documentClass ?? null;
