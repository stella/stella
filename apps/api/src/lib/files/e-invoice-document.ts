import { Result } from "better-result";

import type { EInvoicePreview } from "@stll/api-contract/e-invoice";
import { compareCodeUnit } from "@stll/collation";

import { hasZipMagic } from "@/api/lib/file-scan/zip";
import { DOCUMENT_ARCHIVE_MAX_BYTES } from "@/api/lib/files/archive-preview-protocol";
import {
  DocumentPackageError,
  openDocumentArchive,
  readArchiveEntry,
} from "@/api/lib/files/document-archive";
import { readCiiInvoice } from "@/api/lib/files/e-invoice-cii";
import { readFatturaPaInvoice } from "@/api/lib/files/e-invoice-fattura-pa";
import { readIsdocInvoice } from "@/api/lib/files/e-invoice-isdoc";
import {
  type ParsedEInvoice,
  withDistinctIdentifiers,
} from "@/api/lib/files/e-invoice-nodes";
import { readUblInvoice } from "@/api/lib/files/e-invoice-ubl";
import { classifyXmlDocument } from "@/api/lib/files/xml-document-class";
import {
  documentPackageError,
  type DocumentXmlNode,
  parseStandaloneXml,
} from "@/api/lib/files/xml-document-package";

const SYNTAX_READERS = {
  isdoc: readIsdocInvoice,
  fatturaPA: readFatturaPaInvoice,
  ubl: readUblInvoice,
  cii: readCiiInvoice,
} satisfies Record<
  EInvoicePreview["syntax"],
  (root: DocumentXmlNode) => ParsedEInvoice
>;

// ISDOC 6 packages name their main document in this root-level manifest.
const ISDOCX_MANIFEST = "manifest.xml";
const ISDOCX_MANIFEST_NAMESPACE = "http://isdoc.cz/namespace/2013/manifest";

export type InvoiceAttachment = {
  /** The path the invoice or its package gives the file. */
  fileName: string;
  description: string | null;
  read: () => Result<Uint8Array, DocumentPackageError>;
};

/**
 * A read invoice: the preview without its attachments, and the attachments
 * in their part order. The attachments are listed as parts of the file, with
 * the type their bytes show, when the preview leaves the reader.
 */
export type EInvoiceDocument = {
  preview: Omit<EInvoicePreview, "attachments">;
  attachments: readonly InvoiceAttachment[];
};

/**
 * The largest preview a reader hands on, well inside the 8 MiB the preview
 * workers may answer with, so a signed file's preview keeps its signers and
 * text however large its invoice is.
 */
export const E_INVOICE_PREVIEW_MAX_JSON_BYTES = 3 * 1024 * 1024;

/**
 * Halves every invoice's lines until the preview fits; `lineCount` keeps the
 * file's own count, so a viewer says how many are shown. Nothing else is cut:
 * an invoice that does not fit without its lines is refused as too large.
 */
const fitPreview = (
  preview: EInvoiceDocument["preview"],
): Result<EInvoiceDocument["preview"], DocumentPackageError> => {
  const withLines = (keep: number): EInvoiceDocument["preview"] => ({
    ...preview,
    invoices: preview.invoices.map((invoice) => ({
      ...invoice,
      lines: invoice.lines.slice(0, keep),
    })),
  });
  const fits = (candidate: EInvoiceDocument["preview"]) =>
    Buffer.byteLength(JSON.stringify(candidate)) <=
    E_INVOICE_PREVIEW_MAX_JSON_BYTES;
  let keep = Math.max(0, ...preview.invoices.map((i) => i.lines.length));
  let fitted = preview;
  while (!fits(fitted)) {
    if (keep === 0) {
      return Result.err(
        new DocumentPackageError({
          message: "The invoice exceeds the preview size limit",
          reason: "limit",
        }),
      );
    }
    keep = Math.floor(keep / 2);
    fitted = withLines(keep);
  }
  return Result.ok(fitted);
};

const withAttachments = (
  syntax: EInvoicePreview["syntax"],
  parsed: ParsedEInvoice,
  packaged: readonly InvoiceAttachment[],
): Result<EInvoiceDocument, DocumentPackageError> => {
  const attachments = [
    ...parsed.embedded.map(
      ({ fileName, description, base64 }): InvoiceAttachment => ({
        fileName,
        description,
        read: () => Result.ok(new Uint8Array(Buffer.from(base64, "base64"))),
      }),
    ),
    ...packaged,
  ];
  return fitPreview({
    syntax,
    version: parsed.version,
    invoices: parsed.invoices.map((invoice) => ({
      ...invoice,
      seller: withDistinctIdentifiers(invoice.seller),
      buyer: withDistinctIdentifiers(invoice.buyer),
    })),
  }).map((preview) => ({ preview, attachments }));
};

/**
 * One XML document read as an invoice. `null` means the XML is well formed
 * but its root is not an invoice syntax: plain XML stays unclaimed.
 */
export const readEInvoiceXml = (
  bytes: Uint8Array,
): Result<EInvoiceDocument | null, DocumentPackageError> => {
  const root = parseStandaloneXml(bytes, DOCUMENT_ARCHIVE_MAX_BYTES);
  if (root.isErr()) {
    return Result.err(root.error);
  }
  const documentClass = classifyXmlDocument(root.value);
  if (documentClass === null || documentClass === "xmlSignature") {
    return Result.ok(null);
  }
  const parsed = SYNTAX_READERS[documentClass](root.value);
  return parsed.invoices.length === 0
    ? Result.err(documentPackageError("The invoice holds no document"))
    : withAttachments(documentClass, parsed, []);
};

const manifestMainDocument = (manifest: DocumentXmlNode): string | undefined =>
  manifest.localName === "manifest" &&
  manifest.namespaceURI === ISDOCX_MANIFEST_NAMESPACE
    ? manifest.children
        .find(({ localName }) => localName === "maindocument")
        ?.attributes.get("filename")
    : undefined;

/** An ISDOCX package: the manifest's main ISDOC document and its supplements. */
const readIsdocx = async (
  bytes: Uint8Array,
): Promise<Result<EInvoiceDocument, DocumentPackageError>> => {
  const archive = await openDocumentArchive(bytes);
  if (archive.isErr()) {
    return Result.err(archive.error);
  }
  const entries = archive.value;
  let mainName: string | undefined;
  const manifestEntry = entries.get(ISDOCX_MANIFEST);
  if (manifestEntry) {
    const manifestBytes = readArchiveEntry(manifestEntry);
    if (manifestBytes.isErr()) {
      return Result.err(manifestBytes.error);
    }
    const manifest = parseStandaloneXml(
      manifestBytes.value,
      DOCUMENT_ARCHIVE_MAX_BYTES,
    );
    if (manifest.isErr()) {
      return Result.err(manifest.error);
    }
    mainName = manifestMainDocument(manifest.value);
  } else {
    // Packages written before the manifest became mandatory hold one invoice.
    const candidates = [...entries.keys()].filter(
      (name) => !name.includes("/") && name.toLowerCase().endsWith(".isdoc"),
    );
    mainName = candidates.length === 1 ? candidates[0] : undefined;
  }
  const mainEntry = mainName === undefined ? undefined : entries.get(mainName);
  if (mainName === undefined || !mainEntry) {
    return Result.err(
      documentPackageError("The package does not name its invoice"),
    );
  }
  const mainBytes = readArchiveEntry(mainEntry);
  if (mainBytes.isErr()) {
    return Result.err(mainBytes.error);
  }
  const root = parseStandaloneXml(mainBytes.value, DOCUMENT_ARCHIVE_MAX_BYTES);
  if (root.isErr()) {
    return Result.err(root.error);
  }
  if (classifyXmlDocument(root.value) !== "isdoc") {
    return Result.err(
      documentPackageError("The package's invoice is not an ISDOC document"),
    );
  }
  const packaged = [...entries.entries()]
    .filter(
      ([name]) =>
        !name.endsWith("/") && name !== mainName && name !== ISDOCX_MANIFEST,
    )
    .toSorted(([left], [right]) => compareCodeUnit(left, right))
    .map(([name, entry]): InvoiceAttachment => ({
      fileName: name,
      description: null,
      read: () => readArchiveEntry(entry),
    }));
  return withAttachments("isdoc", readIsdocInvoice(root.value), packaged);
};

/**
 * Reads an invoice file by its content: a ZIP is an ISDOCX package, anything
 * else is one XML document routed by its root. `null` is XML that is not an
 * invoice.
 */
export const readEInvoiceFile = async (
  bytes: Uint8Array,
): Promise<Result<EInvoiceDocument | null, DocumentPackageError>> =>
  hasZipMagic(bytes) ? await readIsdocx(bytes) : readEInvoiceXml(bytes);
