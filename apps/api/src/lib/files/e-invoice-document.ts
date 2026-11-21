import { Result } from "better-result";

import type { EInvoicePreview } from "@stll/api-contract/e-invoice";
import { compareCodeUnit } from "@stll/collation";

import { hasZipMagic } from "@/api/lib/file-scan/zip";
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
    preview: {
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
    },
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
  const root = parseStandaloneXml(bytes);
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
    const manifest = parseStandaloneXml(manifestBytes.value);
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
  const root = parseStandaloneXml(mainBytes.value);
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
