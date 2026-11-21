import { Result } from "better-result";

import {
  certificateSubjectName,
  type SignedDigestAlgorithm,
  type StatedDigest,
} from "@/api/lib/files/cms-signed-data";
import {
  decodeBase64Text,
  type ParsedSignatureFile,
  SIGNATURE_FILE_LIMITS,
  signatureFailure,
  type SignatureParseError,
  type SignatureReference,
  type SignatureSigner,
} from "@/api/lib/files/signature-file";
import {
  type DocumentXmlNode,
  parseXmlDocument,
} from "@/api/lib/files/xml-document-package";

const XMLDSIG_NAMESPACE = "http://www.w3.org/2000/09/xmldsig#";
// Every XAdES version (1.1.1, 1.3.2, 1.4.1) lives under this namespace root.
const XADES_NAMESPACE_ROOT = "http://uri.etsi.org/01903/";
const BASE64_ENCODING = "http://www.w3.org/2000/09/xmldsig#base64";

const DIGEST_METHODS: ReadonlyMap<string, SignedDigestAlgorithm> = new Map([
  ["http://www.w3.org/2000/09/xmldsig#sha1", "SHA-1"],
  ["http://www.w3.org/2001/04/xmldsig-more#sha224", "SHA-224"],
  ["http://www.w3.org/2001/04/xmlenc#sha256", "SHA-256"],
  ["http://www.w3.org/2001/04/xmldsig-more#sha384", "SHA-384"],
  ["http://www.w3.org/2001/04/xmlenc#sha512", "SHA-512"],
]);

const isXmlDsig = (node: DocumentXmlNode, localName: string) =>
  node.namespaceURI === XMLDSIG_NAMESPACE && node.localName === localName;

const isXades = (node: DocumentXmlNode, localName: string) =>
  node.namespaceURI.startsWith(XADES_NAMESPACE_ROOT) &&
  node.localName === localName;

const dsChildren = (node: DocumentXmlNode, localName: string) =>
  node.children.filter((child) => isXmlDsig(child, localName));

/** Depth first, without entering a node `stop` claims. */
function* walk(
  node: DocumentXmlNode,
  stop: (node: DocumentXmlNode) => boolean = () => false,
): Generator<DocumentXmlNode> {
  yield node;
  for (const child of node.children) {
    if (!stop(child)) {
      yield* walk(child, stop);
    }
  }
}

const findDescendant = (
  node: DocumentXmlNode,
  matches: (node: DocumentXmlNode) => boolean,
) => {
  for (const found of walk(node)) {
    if (matches(found)) {
      return found;
    }
  }
  return undefined;
};

const attribute = (node: DocumentXmlNode, name: string) =>
  node.attributes.get(name);

const nodeId = (node: DocumentXmlNode) =>
  attribute(node, "Id") ?? attribute(node, "ID") ?? attribute(node, "id");

/** The readable text of a subtree, one line per text-bearing element. */
const subtreeText = (
  node: DocumentXmlNode,
  stop: (node: DocumentXmlNode) => boolean = () => false,
) => {
  const lines: string[] = [];
  for (const found of walk(node, stop)) {
    const line = found.text.replace(/\s+/gu, " ").trim();
    if (line) {
      lines.push(line);
    }
  }
  return lines.join("\n");
};

const isSignature = (node: DocumentXmlNode) => isXmlDsig(node, "Signature");

/** Outermost signatures only: a countersignature belongs to its signature. */
const outermostSignatures = (node: DocumentXmlNode): DocumentXmlNode[] =>
  isSignature(node) ? [node] : node.children.flatMap(outermostSignatures);

const signingTime = (signature: DocumentXmlNode) => {
  const value = findDescendant(signature, (node) =>
    isXades(node, "SigningTime"),
  )?.text.trim();
  const time = value ? new Date(value) : null;
  return time && !Number.isNaN(time.getTime()) ? time.toISOString() : null;
};

const signerName = (signature: DocumentXmlNode) => {
  const keyInfo = dsChildren(signature, "KeyInfo").at(0);
  const certificate =
    keyInfo &&
    findDescendant(keyInfo, (node) => isXmlDsig(node, "X509Certificate"));
  const der = certificate ? decodeBase64Text(certificate.text) : null;
  return der === null ? null : certificateSubjectName(der);
};

/** The last path segment of an external reference, as a file name. */
const referencedFileName = (uri: string) => {
  const path = uri.split(/[?#]/u, 1)[0] ?? "";
  const segment = path.split(/[/\\]/u).at(-1) ?? "";
  const decoded = Result.try(() => decodeURIComponent(segment));
  const name = (decoded.isOk() ? decoded.value : segment).trim();
  return name.length > 0 && name.length <= 1024 ? name : null;
};

/**
 * A digest compared only against untransformed bytes: once a reference names
 * a transform, its digest covers the transform's output, not the file.
 */
const statedDigest = (reference: DocumentXmlNode): StatedDigest | null => {
  const transforms = dsChildren(reference, "Transforms").at(0);
  if (transforms !== undefined && transforms.children.length > 0) {
    return null;
  }
  const method = dsChildren(reference, "DigestMethod").at(0);
  const algorithm = method
    ? DIGEST_METHODS.get(attribute(method, "Algorithm") ?? "")
    : undefined;
  const value = dsChildren(reference, "DigestValue").at(0);
  const digest = value ? decodeBase64Text(value.text) : null;
  return algorithm === undefined || digest === null
    ? null
    : { algorithm, hex: Buffer.from(digest).toString("hex") };
};

// `#id` or `#xpointer(id('id'))`.
const SAME_DOCUMENT_REFERENCE =
  /^#(?:xpointer\(id\(['"]([^'"]{1,256})['"]\)\)|([^\s#]{1,256}))$/u;

type SignatureRead = {
  signer: SignatureSigner;
  objects: DocumentXmlNode[];
  references: SignatureReference[];
  coversEnclosingDocument: boolean;
};

const readSignature = (
  signature: DocumentXmlNode,
  index: number,
): SignatureRead => {
  // An object holding the signature's qualifying properties is metadata,
  // never the signed document.
  const objects = new Map(
    dsChildren(signature, "Object").flatMap((object) => {
      const id = nodeId(object);
      return id === undefined ||
        findDescendant(object, (node) => isXades(node, "QualifyingProperties"))
        ? []
        : [[id, object] as const];
    }),
  );
  // Ids inside the signature itself (its signed properties, its key info).
  const ownIds = new Set(
    [...walk(signature)].flatMap((node) => {
      const id = nodeId(node);
      return id === undefined ? [] : [id];
    }),
  );
  const signedInfo = dsChildren(signature, "SignedInfo").at(0);
  const read: SignatureRead = {
    signer: {
      id: `signature-${index}.signer-0`,
      name: signerName(signature),
      signedAt: signingTime(signature),
    },
    objects: [],
    references: [],
    coversEnclosingDocument: false,
  };
  for (const reference of signedInfo
    ? dsChildren(signedInfo, "Reference")
    : []) {
    // The signed properties are the signature's own metadata.
    if (attribute(reference, "Type")?.endsWith("#SignedProperties")) {
      continue;
    }
    const uri = attribute(reference, "URI");
    if (uri === undefined || uri === "") {
      read.coversEnclosingDocument = true;
      continue;
    }
    const sameDocument = SAME_DOCUMENT_REFERENCE.exec(uri);
    if (sameDocument) {
      const id = sameDocument[1] ?? sameDocument[2] ?? "";
      const object = objects.get(id);
      if (object) {
        read.objects.push(object);
      } else if (!ownIds.has(id)) {
        read.coversEnclosingDocument = true;
      }
      continue;
    }
    read.references.push({
      fileName: referencedFileName(uri),
      digest: statedDigest(reference),
    });
  }
  return read;
};

/** An enveloping object's bytes: base64 unless it holds XML elements. */
const embeddedObject = (
  object: DocumentXmlNode,
): Pick<ParsedSignatureFile, "embedded" | "documentText"> => {
  if (object.children.length > 0) {
    return { embedded: null, documentText: subtreeText(object) || null };
  }
  const bytes = decodeBase64Text(object.text);
  const declaredBase64 = attribute(object, "Encoding") === BASE64_ENCODING;
  if (bytes === null) {
    return {
      embedded: null,
      documentText: declaredBase64 ? null : object.text.trim() || null,
    };
  }
  return {
    embedded: { bytes, mimeType: attribute(object, "MimeType") ?? null },
    documentText: null,
  };
};

const XMLDSIG_MARKER = Buffer.from(XMLDSIG_NAMESPACE);
const XADES_MARKER = Buffer.from(XADES_NAMESPACE_ROOT);

/** Plain XML is turned away before it is parsed as a signature. */
const mayHoldXadesSignature = (bytes: Uint8Array) => {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const utf16 =
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff);
  return (
    utf16 || (buffer.includes(XMLDSIG_MARKER) && buffer.includes(XADES_MARKER))
  );
};

/**
 * An XAdES signature in its own file (enveloping or detached) or inside the
 * XML document it signs (enveloped). Plain XML and XML signatures without
 * XAdES signed properties are not claimed. Nothing here is verified.
 */
export const parseXadesFile = (
  bytes: Uint8Array,
): Result<ParsedSignatureFile, SignatureParseError> => {
  if (bytes.byteLength > SIGNATURE_FILE_LIMITS.maxFileBytes) {
    return signatureFailure("too_large");
  }
  if (!mayHoldXadesSignature(bytes)) {
    return signatureFailure("not_signature");
  }
  const parsed = parseXmlDocument(bytes);
  if (parsed.isErr()) {
    return signatureFailure(
      parsed.error.reason === "limit" ? "limit" : "not_signature",
    );
  }
  const root = parsed.value;
  const signatures = outermostSignatures(root).filter((signature) =>
    findDescendant(signature, (node) => isXades(node, "QualifyingProperties")),
  );
  if (signatures.length === 0) {
    return signatureFailure("not_signature");
  }
  if (signatures.length > SIGNATURE_FILE_LIMITS.maxEntries) {
    return signatureFailure("limit");
  }
  const reads = signatures.map(readSignature);
  const references = reads.flatMap((read) => read.references);
  if (references.length > SIGNATURE_FILE_LIMITS.maxEntries) {
    return signatureFailure("limit");
  }
  const signers = reads.map(({ signer }) => signer);
  // A signature root, or a container holding only signatures, stands alone.
  // Any other root is the signed document itself.
  const standsAlone =
    isSignature(root) ||
    (root.children.every(isSignature) &&
      !reads.some((read) => read.coversEnclosingDocument));
  if (!standsAlone) {
    return Result.ok({
      standard: "xades",
      packaging: "enveloped",
      signers,
      references,
      embedded: null,
      documentText: subtreeText(root, isSignature) || null,
    });
  }
  const object = reads.flatMap((read) => read.objects).at(0);
  if (object !== undefined) {
    return Result.ok({
      standard: "xades",
      packaging: "enveloping",
      signers,
      references,
      ...embeddedObject(object),
    });
  }
  if (references.length === 0) {
    return signatureFailure("unsupported");
  }
  return Result.ok({
    standard: "xades",
    packaging: "detached",
    signers,
    references,
    embedded: null,
    documentText: null,
  });
};
