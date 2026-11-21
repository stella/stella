import { Result } from "better-result";

import { E_AKTA_FILE_FORMAT } from "@stll/api-contract/signed-dossier-formats";

import { DOCUMENT_ARCHIVE_MAX_BYTES } from "@/api/lib/files/archive-preview-protocol";
import type { ContainerMember } from "@/api/lib/files/asic-preview-worker";
import {
  openDocumentArchive,
  readArchiveEntry,
} from "@/api/lib/files/document-archive";
import {
  dossierDocumentName,
  dossierLimit,
  invalidDossier,
  MAX_DOSSIER_DOCUMENTS,
  MAX_DOSSIER_SIGNATURES,
  type SignedDossier,
  SignedDossierParseError,
} from "@/api/lib/files/signed-dossier";
import {
  childElements,
  decodeXmlBase64,
  readXadesSigners,
  XMLDSIG_NAMESPACE,
} from "@/api/lib/files/xades-signers";
import {
  type DocumentXmlNode,
  parseStandaloneXml,
} from "@/api/lib/files/xml-document-package";

// Microsec, "Az e-akta formátum specifikációja" v1.5 (2015). §4 lets
// special-purpose dossiers bind the `es` prefix to their own namespace, so
// e-akta elements are matched by local name; XML signature elements are not.

const named = (node: DocumentXmlNode, localName: string) =>
  node.children.filter((child) => child.localName === localName);

const first = (node: DocumentXmlNode | undefined, localName: string) =>
  node === undefined ? undefined : named(node, localName).at(0);

// A dossier can hold another dossier as a document. Nested containers stay
// opaque, like a ZIP inside an ASiC container.
const NESTED_DOSSIER = /^\s*(?:<\?xml[^>]*\?>\s*)?<(?:[\w.-]+:)?Dossier[\s/>]/u;

const isNestedDossier = (bytes: Uint8Array, fileName: string) =>
  E_AKTA_FILE_FORMAT.extensions.some((extension) =>
    fileName.toLowerCase().endsWith(extension),
  ) || NESTED_DOSSIER.test(Buffer.from(bytes.subarray(0, 1024)).toString());

type Budget = { remainingBytes: number };

// The `zip` transform stores the document as a ZIP archive of one file.
const unzipDocument = async (
  bytes: Uint8Array,
  budget: Budget,
): Promise<Result<Uint8Array, SignedDossierParseError>> => {
  const archive = await openDocumentArchive(bytes);
  if (archive.isErr()) {
    return invalidDossier(archive.error.message);
  }
  const files = [...archive.value].filter(([name]) => !name.endsWith("/"));
  const [only] = files;
  if (files.length !== 1 || only === undefined) {
    return invalidDossier("A zipped dossier document must hold one file");
  }
  const [, entry] = only;
  budget.remainingBytes -= entry.uncompressedSize;
  if (budget.remainingBytes < 0) {
    return dossierLimit("The dossier exceeds the supported size");
  }
  const content = readArchiveEntry(entry);
  return content.isOk()
    ? Result.ok(content.value)
    : invalidDossier(content.error.message);
};

const readDocument = async (
  document: DocumentXmlNode,
  position: number,
  budget: Budget,
): Promise<Result<ContainerMember, SignedDossierParseError>> => {
  const profile = first(document, "DocumentProfile");
  const mime = first(first(profile, "Format"), "MIME-Type");
  const fileName = dossierDocumentName(
    first(profile, "Title")?.text,
    position,
    mime?.attributes.get("extension"),
  );
  const baseTransform = first(profile, "BaseTransform");
  const transforms = (
    baseTransform === undefined ? [] : named(baseTransform, "Transform")
  ).map((transform) => transform.attributes.get("Algorithm"));
  const [object, ...extra] = childElements(
    document,
    XMLDSIG_NAMESPACE,
    "Object",
  );
  if (object === undefined || extra.length > 0) {
    return invalidDossier("A dossier document has no single embedded object");
  }
  const opaque = { fileName, bytes: new Uint8Array(), opaque: true };
  // §5: a reader accepts a document whose embedded object is empty.
  if (!object.text.trim() && object.children.length === 0) {
    return Result.ok(opaque);
  }
  const decoded = decodeXmlBase64(object.text);
  if (decoded === null || object.children.length > 0) {
    return invalidDossier("A dossier document is not base64 encoded");
  }
  // Encrypted documents are addressed to their recipients only.
  if (transforms.includes("encrypt")) {
    return Result.ok({ ...opaque, bytes: decoded });
  }
  let bytes = decoded;
  if (transforms.includes("zip")) {
    const unzipped = await unzipDocument(decoded, budget);
    if (unzipped.isErr()) {
      // One unreadable document is listed as such; the others stay readable.
      return unzipped.error.reason === "limit"
        ? Result.err(unzipped.error)
        : Result.ok({ ...opaque, bytes: decoded });
    }
    bytes = unzipped.value;
  }
  return Result.ok({
    fileName,
    bytes,
    opaque: isNestedDossier(bytes, fileName),
  });
};

const signerNameStatedBy = (signature: DocumentXmlNode) =>
  childElements(signature, XMLDSIG_NAMESPACE, "Object")
    .flatMap((object) => named(object, "SignatureProfile"))
    .flatMap((profile) => named(profile, "SignerName"))
    .at(0)?.text;

/** Reads an e-akta dossier's documents and stated signers. */
export const readEAktaDossier = async (
  bytes: Uint8Array,
): Promise<Result<SignedDossier, SignedDossierParseError>> => {
  const parsed = parseStandaloneXml(bytes, DOCUMENT_ARCHIVE_MAX_BYTES);
  if (parsed.isErr()) {
    return Result.err(
      new SignedDossierParseError({
        message: parsed.error.message,
        reason: parsed.error.reason,
      }),
    );
  }
  const root = parsed.value;
  const [documents, ...extraDocuments] = named(root, "Documents");
  if (
    root.localName !== "Dossier" ||
    named(root, "DossierProfile").length !== 1 ||
    documents === undefined ||
    extraDocuments.length > 0
  ) {
    return invalidDossier("The file is not an e-akta dossier");
  }
  const entries = named(documents, "Document");
  if (entries.length > MAX_DOSSIER_DOCUMENTS) {
    return dossierLimit("The dossier holds too many documents");
  }
  const budget = { remainingBytes: DOCUMENT_ARCHIVE_MAX_BYTES };
  const members: ContainerMember[] = [];
  for (const [position, entry] of entries.entries()) {
    const member = await readDocument(entry, position, budget);
    if (member.isErr()) {
      return Result.err(member.error);
    }
    members.push(member.value);
  }
  // Frame signatures cover the whole dossier and follow its documents; the
  // specification's example also draws one inside the document list.
  const signatures = [
    ...childElements(root, XMLDSIG_NAMESPACE, "Signature"),
    ...childElements(documents, XMLDSIG_NAMESPACE, "Signature"),
    ...entries.flatMap((entry) =>
      childElements(entry, XMLDSIG_NAMESPACE, "Signature"),
    ),
  ];
  if (signatures.length > MAX_DOSSIER_SIGNATURES) {
    return dossierLimit("The dossier holds too many signatures");
  }
  return Result.ok({
    documents: members,
    signers: readXadesSigners(signatures, "signature", signerNameStatedBy),
  });
};
