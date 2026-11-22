import { Result } from "better-result";

import type { EInvoice, EInvoicePreview } from "@stll/api-contract/e-invoice";
import { compareCodeUnit } from "@stll/collation";

import { hasZipMagic } from "@/api/lib/file-scan/zip";
import { DOCUMENT_ARCHIVE_MAX_BYTES } from "@/api/lib/files/archive-preview-protocol";
import {
  type DocumentPackageError,
  openDocumentArchive,
  readArchiveEntry,
} from "@/api/lib/files/document-archive";
import { readCiiInvoice } from "@/api/lib/files/e-invoice-cii";
import { readFatturaPaInvoice } from "@/api/lib/files/e-invoice-fattura-pa";
import { readIsdocInvoice } from "@/api/lib/files/e-invoice-isdoc";
import {
  base64DecodedSize,
  type ParsedEInvoice,
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

type InvoiceAttachment = {
  fileName: string;
  description: string | null;
  sizeBytes: number;
  read: () => Result<Uint8Array, DocumentPackageError>;
};

/** A read invoice: the preview, and its attachments by preview index. */
export type EInvoiceDocument = {
  preview: EInvoicePreview;
  attachments: readonly InvoiceAttachment[];
};

/**
 * The largest preview a reader hands on, well inside the 8 MiB the preview
 * workers may answer with, so a signed file's preview keeps its signers and
 * text however large its invoice is.
 */
export const E_INVOICE_PREVIEW_MAX_JSON_BYTES = 3 * 1024 * 1024;

type PreviewList =
  "lines" | "notes" | "vatBreakdown" | "payments" | "invoices" | "attachments";

type InvoiceList = Exclude<PreviewList, "invoices" | "attachments">;

const listLength = (preview: EInvoicePreview, list: PreviewList): number => {
  if (list === "invoices" || list === "attachments") {
    return preview[list].length;
  }
  return Math.max(0, ...preview.invoices.map((i) => i[list].length));
};

const halveInvoiceList = (
  invoice: EInvoice,
  list: InvoiceList,
  keep: number,
): EInvoice => {
  if (list === "lines") {
    return { ...invoice, lines: invoice.lines.slice(0, keep) };
  }
  if (list === "notes") {
    return { ...invoice, notes: invoice.notes.slice(0, keep) };
  }
  if (list === "vatBreakdown") {
    return { ...invoice, vatBreakdown: invoice.vatBreakdown.slice(0, keep) };
  }
  return { ...invoice, payments: invoice.payments.slice(0, keep) };
};

const halveList = (
  preview: EInvoicePreview,
  list: PreviewList,
  keep: number,
): EInvoicePreview => {
  if (list === "invoices") {
    return { ...preview, invoices: preview.invoices.slice(0, keep) };
  }
  if (list === "attachments") {
    return { ...preview, attachments: preview.attachments.slice(0, keep) };
  }
  return {
    ...preview,
    invoices: preview.invoices.map((invoice) =>
      halveInvoiceList(invoice, list, keep),
    ),
  };
};

const PREVIEW_LISTS: readonly PreviewList[] = [
  "lines",
  "notes",
  "vatBreakdown",
  "payments",
  "invoices",
  "attachments",
];

/**
 * Halves the longest list until the preview fits. Counts the file states,
 * such as `lineCount`, keep their values, so a viewer can say what is left out.
 */
const fitPreview = (preview: EInvoicePreview): EInvoicePreview => {
  let fitted = preview;
  while (
    Buffer.byteLength(JSON.stringify(fitted)) > E_INVOICE_PREVIEW_MAX_JSON_BYTES
  ) {
    const current = fitted;
    const [longest] = PREVIEW_LISTS.map((list) => ({
      list,
      length: listLength(current, list),
    })).toSorted((left, right) => right.length - left.length);
    if (longest === undefined || longest.length <= 1) {
      break;
    }
    fitted = halveList(fitted, longest.list, Math.floor(longest.length / 2));
  }
  return fitted;
};

const withAttachments = (
  syntax: EInvoicePreview["syntax"],
  parsed: ParsedEInvoice,
  packaged: readonly InvoiceAttachment[],
): EInvoiceDocument => {
  const attachments = [
    ...parsed.embedded.map(
      ({ fileName, description, base64 }): InvoiceAttachment => ({
        fileName,
        description,
        sizeBytes: base64DecodedSize(base64),
        read: () => Result.ok(new Uint8Array(Buffer.from(base64, "base64"))),
      }),
    ),
    ...packaged,
  ];
  return {
    preview: fitPreview({
      syntax,
      version: parsed.version,
      invoices: parsed.invoices,
      attachments: attachments.map(
        ({ fileName, description, sizeBytes }, index) => ({
          index,
          fileName,
          description,
          sizeBytes,
        }),
      ),
    }),
    attachments,
  };
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
    : Result.ok(withAttachments(documentClass, parsed, []));
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
      sizeBytes: entry.uncompressedSize,
      read: () => readArchiveEntry(entry),
    }));
  return Result.ok(
    withAttachments("isdoc", readIsdocInvoice(root.value), packaged),
  );
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
