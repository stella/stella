import { Result } from "better-result";
import { createHash } from "node:crypto";

import { sha256Hex } from "@stll/sha256/bun";

import {
  certificateSubjectName,
  type SignedDigestAlgorithm,
  type StatedDigest,
  statedDigestOf,
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
  parseStandaloneXml,
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

const singleLine = (text: string) => text.replace(/\s+/gu, " ").trim();

/** A node's text with its children's, in document order. */
const inlineText = (
  node: DocumentXmlNode,
  stop: (node: DocumentXmlNode) => boolean,
): string =>
  node.content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      return stop(part) ? "" : ` ${inlineText(part, stop)} `;
    })
    .join("");

/**
 * The readable text of a subtree: an element holding text beside its
 * children reads as one line in document order; an element holding only
 * elements reads as one line per child.
 */
const subtreeText = (
  node: DocumentXmlNode,
  stop: (node: DocumentXmlNode) => boolean = () => false,
): string => {
  if (node.text.trim() !== "" || node.children.length === 0) {
    return singleLine(inlineText(node, stop));
  }
  return node.children
    .filter((child) => !stop(child))
    .map((child) => subtreeText(child, stop))
    .filter((line) => line !== "")
    .join("\n");
};

const isSignature = (node: DocumentXmlNode) => isXmlDsig(node, "Signature");

/** Outermost signatures only: a countersignature belongs to its signature. */
const outermostSignatures = (node: DocumentXmlNode): DocumentXmlNode[] =>
  isSignature(node) ? [node] : node.children.flatMap(outermostSignatures);

/** A digest method and value, when both are well formed. */
const statedDigest = (holder: DocumentXmlNode): StatedDigest | null => {
  const method = dsChildren(holder, "DigestMethod").at(0);
  const algorithm = method
    ? DIGEST_METHODS.get(attribute(method, "Algorithm") ?? "")
    : undefined;
  const value = dsChildren(holder, "DigestValue").at(0);
  const digest = value ? decodeBase64Text(value.text) : null;
  return algorithm === undefined || digest === null
    ? null
    : statedDigestOf(algorithm, digest);
};

/** The signature's own nodes: a countersignature inside it is its own. */
const ownNodes = (signature: DocumentXmlNode) => [
  ...walk(signature, isSignature),
];

const signingTime = (own: readonly DocumentXmlNode[]) => {
  const value = own.find((node) => isXades(node, "SigningTime"))?.text.trim();
  const time = value ? new Date(value) : null;
  return time && !Number.isNaN(time.getTime()) ? time.toISOString() : null;
};

const CERTIFICATE_DIGESTS = {
  "SHA-1": (der) => createHash("sha1").update(der).digest("hex"),
  "SHA-224": (der) => createHash("sha224").update(der).digest("hex"),
  "SHA-256": (der) => sha256Hex(der),
  "SHA-384": (der) => createHash("sha384").update(der).digest("hex"),
  "SHA-512": (der) => createHash("sha512").update(der).digest("hex"),
} as const satisfies Record<SignedDigestAlgorithm, (der: Uint8Array) => string>;

/** The digests the signed properties state for the signing certificate. */
const signingCertificateDigests = (own: readonly DocumentXmlNode[]) =>
  own
    .filter((node) => isXades(node, "CertDigest"))
    .flatMap((certDigest) => {
      const digest = statedDigest(certDigest);
      return digest === null ? [] : [digest];
    });

/**
 * The signer's certificate: the only one the key info holds, or the one the
 * signed properties identify by digest. Certificates need not come signer
 * first, so with several and none identified the signer stays unnamed.
 */
const signerName = (
  signature: DocumentXmlNode,
  own: readonly DocumentXmlNode[],
) => {
  const keyInfo = dsChildren(signature, "KeyInfo").at(0);
  const certificates = keyInfo
    ? [...walk(keyInfo)].flatMap((node) => {
        const der = isXmlDsig(node, "X509Certificate")
          ? decodeBase64Text(node.text)
          : null;
        return der === null ? [] : [der];
      })
    : [];
  if (certificates.length <= 1) {
    const only = certificates.at(0);
    return only === undefined ? null : certificateSubjectName(only);
  }
  const digests = signingCertificateDigests(own);
  const identified = certificates.filter((der) =>
    digests.some(
      ({ algorithm, hex }) => CERTIFICATE_DIGESTS[algorithm](der) === hex,
    ),
  );
  const signer = identified.length === 1 ? identified.at(0) : undefined;
  return signer === undefined ? null : certificateSubjectName(signer);
};

/** The last path segment of an external reference, as a file name. */
const referencedFileName = (uri: string) => {
  const path = uri.split(/[?#]/u, 1)[0] ?? "";
  const segment = path.split(/[/\\]/u).at(-1) ?? "";
  const decoded = Result.try(() => decodeURIComponent(segment));
  const name = (decoded.isOk() ? decoded.value : segment).trim();
  return name.length > 0 && name.length <= 1024 ? name : null;
};

const transformsOf = (reference: DocumentXmlNode) =>
  dsChildren(reference, "Transforms").flatMap((transforms) =>
    dsChildren(transforms, "Transform"),
  );

/**
 * A digest compared only against a whole file's untransformed bytes: once a
 * reference names a transform or a fragment, its digest covers that output.
 */
const fileDigest = (
  reference: DocumentXmlNode,
  uri: string,
): StatedDigest | null =>
  transformsOf(reference).length > 0 || uri.includes("#")
    ? null
    : statedDigest(reference);

// `#id` or `#xpointer(id('id'))`.
const SAME_DOCUMENT_REFERENCE =
  /^#(?:xpointer\(id\(['"]([^'"]{1,256})['"]\)\)|([^\s#]{1,256}))$/u;

type SignedObject = { node: DocumentXmlNode; base64Transform: boolean };

type SignatureRead = {
  signer: SignatureSigner;
  objects: SignedObject[];
  references: SignatureReference[];
  /** A `URI=""` reference: the whole document holding the signature. */
  coversEnclosingDocument: boolean;
  /** Elements of the enclosing document a `#id` reference signs. */
  enclosedTargets: DocumentXmlNode[];
};

const idsOf = (nodes: Iterable<DocumentXmlNode>) =>
  new Map(
    [...nodes].flatMap((node) => {
      const id = nodeId(node);
      return id === undefined ? [] : [[id, node] as const];
    }),
  );

/** The ids of the signed properties this signature's own properties hold. */
const signedPropertiesIds = (own: readonly DocumentXmlNode[]) =>
  new Set(
    own
      .filter((node) => isXades(node, "SignedProperties"))
      .flatMap((node) => {
        const id = nodeId(node);
        return id === undefined ? [] : [id];
      }),
  );

const sameDocumentId = (uri: string) => {
  const match = SAME_DOCUMENT_REFERENCE.exec(uri);
  return match ? (match[1] ?? match[2] ?? "") : null;
};

/**
 * An XAdES signature has signed properties of its own that its signed info
 * references; qualifying properties alone, or a countersignature's, do not
 * make an XML signature XAdES. This reads structure only; nothing is verified.
 */
const hasSignedProperties = (signature: DocumentXmlNode) => {
  const ids = signedPropertiesIds(ownNodes(signature));
  const signedInfo = dsChildren(signature, "SignedInfo").at(0);
  return (signedInfo ? dsChildren(signedInfo, "Reference") : []).some(
    (reference) => {
      const id = sameDocumentId(attribute(reference, "URI") ?? "");
      return id !== null && ids.has(id);
    },
  );
};

const readSignature = (
  signature: DocumentXmlNode,
  index: number,
  documentIds: ReadonlyMap<string, DocumentXmlNode>,
): SignatureRead => {
  const own = ownNodes(signature);
  // An object holding the signature's qualifying properties is metadata,
  // never the signed document. A reference may name the object or an
  // element inside it.
  const objects = new Map(
    dsChildren(signature, "Object")
      .filter(
        (object) =>
          !findDescendant(object, (node) =>
            isXades(node, "QualifyingProperties"),
          ),
      )
      .flatMap((object) => [...idsOf(walk(object))]),
  );
  const signedInfo = dsChildren(signature, "SignedInfo").at(0);
  const read: SignatureRead = {
    signer: {
      id: `signature-${index}.signer-0`,
      name: signerName(signature, own),
      signedAt: signingTime(own),
    },
    objects: [],
    references: [],
    coversEnclosingDocument: false,
    enclosedTargets: [],
  };
  for (const reference of signedInfo
    ? dsChildren(signedInfo, "Reference")
    : []) {
    // The signed properties are the signature's own metadata.
    if (attribute(reference, "Type")?.endsWith("#SignedProperties")) {
      continue;
    }
    const uri = attribute(reference, "URI");
    // An omitted URI leaves the signed data to the application: nothing
    // here says what it is.
    if (uri === undefined) {
      continue;
    }
    if (uri === "") {
      read.coversEnclosingDocument = true;
      continue;
    }
    const id = sameDocumentId(uri);
    if (id !== null) {
      const object = objects.get(id);
      const target = documentIds.get(id);
      if (object) {
        read.objects.push({
          node: object,
          base64Transform: transformsOf(reference).some(
            (transform) =>
              attribute(transform, "Algorithm") === BASE64_ENCODING,
          ),
        });
      } else if (target) {
        read.enclosedTargets.push(target);
      }
      continue;
    }
    read.references.push({
      fileName: referencedFileName(uri),
      digest: fileDigest(reference, uri),
    });
  }
  return read;
};

const TEXT_MEDIA_TYPE = /^(?:text\/|application\/(?:[\w.+-]+\+)?xml$)/iu;

/**
 * An enveloping object's content. It is base64 only when it says so: by its
 * encoding, by a base64 transform, or by a media type that is not text.
 * Otherwise its text is the document, even when it happens to parse as base64.
 */
const embeddedObject = ({
  node,
  base64Transform,
}: SignedObject): Pick<ParsedSignatureFile, "embedded" | "documentText"> => {
  if (node.children.length > 0) {
    return { embedded: null, documentText: subtreeText(node) || null };
  }
  const mimeType = attribute(node, "MimeType") ?? null;
  const declaredBase64 =
    attribute(node, "Encoding") === BASE64_ENCODING || base64Transform;
  const binary = mimeType !== null && !TEXT_MEDIA_TYPE.test(mimeType);
  if (!declaredBase64 && !binary) {
    return { embedded: null, documentText: node.text.trim() || null };
  }
  const bytes = decodeBase64Text(node.text);
  if (bytes === null) {
    return {
      embedded: null,
      documentText: declaredBase64 ? null : node.text.trim() || null,
    };
  }
  return { embedded: { bytes, mimeType }, documentText: null };
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
  const parsed = parseStandaloneXml(bytes, SIGNATURE_FILE_LIMITS.maxFileBytes);
  if (parsed.isErr()) {
    return signatureFailure(
      parsed.error.reason === "limit" ? "limit" : "not_signature",
    );
  }
  const root = parsed.value;
  const signatures = outermostSignatures(root).filter(hasSignedProperties);
  if (signatures.length === 0) {
    return signatureFailure("not_signature");
  }
  if (signatures.length > SIGNATURE_FILE_LIMITS.maxEntries) {
    return signatureFailure("limit");
  }
  // Ids of the enclosing document's own elements, outside every signature.
  const documentIds = isSignature(root)
    ? new Map<string, DocumentXmlNode>()
    : idsOf(walk(root, isSignature));
  const reads = signatures.map((signature, index) =>
    readSignature(signature, index, documentIds),
  );
  const references = reads.flatMap((read) => read.references);
  if (references.length > SIGNATURE_FILE_LIMITS.maxEntries) {
    return signatureFailure("limit");
  }
  const signers = reads.map(({ signer }) => signer);
  // A signature is enveloped when it signs its enclosing document: the whole
  // of it, or elements of it. A wrapper whose signatures sign only other
  // files or their own objects stands alone, whatever else it holds.
  const wholeDocument = reads.some((read) => read.coversEnclosingDocument);
  const targets = [...new Set(reads.flatMap((read) => read.enclosedTargets))];
  if (!isSignature(root) && (wholeDocument || targets.length > 0)) {
    const documentText = wholeDocument
      ? subtreeText(root, isSignature)
      : targets
          .map((target) => subtreeText(target, isSignature))
          .filter((text) => text !== "")
          .join("\n");
    return Result.ok({
      standard: "xades",
      packaging: "enveloped",
      signers,
      references,
      embedded: null,
      documentText: documentText || null,
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
