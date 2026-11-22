import { Result } from "better-result";

import { DOCUMENT_ARCHIVE_MAX_BYTES } from "@/api/lib/files/archive-preview-protocol";
import type { ContainerMember } from "@/api/lib/files/asic-preview-worker";
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
  xmlSignatures,
} from "@/api/lib/files/xades-signers";
import {
  type DocumentXmlNode,
  parseStandaloneXml,
} from "@/api/lib/files/xml-document-package";

// Ditec, "Profil XAdES_ZEP" v2.0 (2017) §4.2 and its XSDs: an `xzep:DataEnvelope`
// holds the signed data objects as `ds:Object` elements, beside one
// `ds:Signature` (detached form) or inside it (enveloping form). The composite
// form, `xzepds:DataSignatures`, holds several signatures over its objects.
const ENVELOPE_ROOTS = new Map([
  ["http://www.ditec.sk/ep/signature_formats/xades_zep/v1.0", "DataEnvelope"],
  ["http://www.ditec.sk/ep/signature_formats/xades_zep/v1.1", "DataEnvelope"],
  ["http://www.ditec.sk/ep/signature_formats/xades_zep/v2.0", "DataEnvelope"],
  [
    "http://www.ditec.sk/ep/signature_formats/xades_zep_data_signatures/v1.0",
    "DataSignatures",
  ],
  [
    "http://www.ditec.sk/ep/signature_formats/xades_zep_data_signatures/v1.1",
    "DataSignatures",
  ],
  [
    "http://www.ditec.sk/ep/signature_formats/xades_zep_data_signatures/v2.0",
    "DataSignatures",
  ],
]);
const XADES_NAMESPACES = new Set([
  "http://uri.etsi.org/01903/v1.3.2#",
  "http://uri.etsi.org/01903/v1.4.1#",
]);
// §4.4.4.1 names a data object's type by MIME type; files get the usual suffix.
const EXTENSIONS = new Map([
  ["application/pdf", "pdf"],
  ["application/xml", "xml"],
  ["text/xml", "xml"],
  ["text/plain", "txt"],
  ["application/rtf", "rtf"],
  ["text/rtf", "rtf"],
  ["image/png", "png"],
  ["image/tiff", "tiff"],
  ["image/jpeg", "jpg"],
]);
const TEXT_MIME_TYPES = new Set(["application/xml", "text/xml", "text/plain"]);
const BASE64_ENCODING = /base64$/iu;

const descendants = (
  node: DocumentXmlNode,
  matches: (node: DocumentXmlNode) => boolean,
): DocumentXmlNode[] => {
  const found: DocumentXmlNode[] = [];
  const pending = node.children.toReversed();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (matches(next)) {
      found.push(next);
    }
    pending.push(...next.children.toReversed());
  }
  return found;
};

const isDsig = (node: DocumentXmlNode, localName: string) =>
  node.namespaceURI === XMLDSIG_NAMESPACE && node.localName === localName;

const isXades = (node: DocumentXmlNode, localName: string) =>
  XADES_NAMESPACES.has(node.namespaceURI) && node.localName === localName;

const fragmentId = (uri: string | undefined) =>
  uri?.startsWith("#") === true ? uri.slice(1) : undefined;

/** The local fragment Ids a set of references point at. */
const fragmentTargets = (references: readonly DocumentXmlNode[]) =>
  references
    .map((reference) => fragmentId(reference.attributes.get("URI")))
    .filter((id) => id !== undefined);

type DataObjectFormat = {
  description: string | undefined;
  mimeType: string | undefined;
};

/**
 * Each referenced object's stated description and MIME type. A format names a
 * `ds:Reference` by its Id; that reference points at the object, or at a
 * `ds:Manifest` whose references point at it.
 */
const objectFormats = (root: DocumentXmlNode) => {
  const references = descendants(root, (node) => isDsig(node, "Reference"));
  const referencedBy = new Map(
    references.flatMap((reference) => {
      const id = reference.attributes.get("Id");
      return id === undefined ? [] : [[id, reference] as const];
    }),
  );
  const manifests = new Map(
    descendants(root, (node) => isDsig(node, "Manifest")).flatMap(
      (manifest) => {
        const id = manifest.attributes.get("Id");
        return id === undefined ? [] : [[id, manifest] as const];
      },
    ),
  );
  const formats = new Map<string, DataObjectFormat>();
  for (const format of descendants(root, (node) =>
    isXades(node, "DataObjectFormat"),
  )) {
    const reference = referencedBy.get(
      fragmentId(format.attributes.get("ObjectReference")) ?? "",
    );
    const target = fragmentId(reference?.attributes.get("URI"));
    if (target === undefined) {
      continue;
    }
    const manifest = manifests.get(target);
    const objectIds = manifest
      ? fragmentTargets(childElements(manifest, XMLDSIG_NAMESPACE, "Reference"))
      : [target];
    const stated = {
      description: format.children
        .find((child) => isXades(child, "Description"))
        ?.text.trim(),
      mimeType: format.children
        .find((child) => isXades(child, "MimeType"))
        ?.text.trim()
        .toLowerCase(),
    };
    for (const id of objectIds) {
      if (!formats.has(id)) {
        formats.set(id, stated);
      }
    }
  }
  return formats;
};

/** Text an inline XML object holds, one element's text per line. */
const inlineXmlText = (object: DocumentXmlNode) =>
  descendants(object, () => true)
    .map((node) => node.text.trim())
    .filter(Boolean)
    .join("\n");

const referencedIds = (root: DocumentXmlNode) =>
  new Set(
    fragmentTargets(descendants(root, (node) => isDsig(node, "Reference"))),
  );

const readObject = (
  object: DocumentXmlNode,
  format: DataObjectFormat | undefined,
  position: number,
): Result<ContainerMember, SignedDossierParseError> => {
  const mimeType = (format?.mimeType ?? object.attributes.get("MimeType"))
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  const fileName = dossierDocumentName(
    format?.description,
    position,
    EXTENSIONS.get(mimeType ?? ""),
  );
  if (object.children.length > 0) {
    // An XML data object is embedded as XML; its text is what a reader sees.
    return Result.ok({
      fileName,
      bytes: new TextEncoder().encode(inlineXmlText(object)),
    });
  }
  // CEP and §4.2 store binary objects in base64 and mark them so; a text
  // object without the mark is its own text.
  const encoding = object.attributes.get("Encoding");
  const isText =
    (encoding === undefined || !BASE64_ENCODING.test(encoding)) &&
    mimeType !== undefined &&
    TEXT_MIME_TYPES.has(mimeType);
  if (isText) {
    return Result.ok({
      fileName,
      bytes: new TextEncoder().encode(object.text.trim()),
    });
  }
  const bytes = decodeXmlBase64(object.text);
  if (bytes === null) {
    return invalidDossier("A signed data object is not base64 encoded");
  }
  // An empty object is listed; there is nothing in it to read.
  return Result.ok({ fileName, bytes, opaque: bytes.byteLength === 0 });
};

/** Reads a XAdES_ZEP envelope's signed data objects and stated signers. */
export const readXadesZepEnvelope = (
  bytes: Uint8Array,
): Result<SignedDossier, SignedDossierParseError> => {
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
  const signatures = childElements(root, XMLDSIG_NAMESPACE, "Signature");
  if (
    ENVELOPE_ROOTS.get(root.namespaceURI) !== root.localName ||
    signatures.length === 0
  ) {
    return invalidDossier("The file is not a XAdES_ZEP data envelope");
  }
  if (signatures.length > MAX_DOSSIER_SIGNATURES) {
    return dossierLimit("The envelope holds too many signatures");
  }
  // Data objects sit beside the signature or, enveloped, inside it. Only an
  // object a signature references is signed data; the signature's own
  // properties and key information are not.
  const signed = referencedIds(root);
  const objects = [
    ...childElements(root, XMLDSIG_NAMESPACE, "Object"),
    ...signatures.flatMap((signature) =>
      childElements(signature, XMLDSIG_NAMESPACE, "Object"),
    ),
  ].filter((object) => signed.has(object.attributes.get("Id") ?? ""));
  if (objects.length > MAX_DOSSIER_DOCUMENTS) {
    return dossierLimit("The envelope holds too many data objects");
  }
  const formats = objectFormats(root);
  const documents: ContainerMember[] = [];
  for (const [position, object] of objects.entries()) {
    const document = readObject(
      object,
      formats.get(object.attributes.get("Id") ?? ""),
      position,
    );
    if (document.isErr()) {
      return Result.err(document.error);
    }
    documents.push(document.value);
  }
  return Result.ok({
    receipt: false,
    documents,
    signers: readXadesSigners(xmlSignatures(root), "signature"),
  });
};
