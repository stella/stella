import { Result } from "better-result";
import * as pkijs from "pkijs";

import { sha256Base64 } from "@stll/sha256/bun";

import {
  nameAttribute,
  signerDisplayName,
} from "@/api/lib/files/cms-signed-data";
import type { DocumentXmlNode } from "@/api/lib/files/xml-document-package";

export const XMLDSIG_NAMESPACE = "http://www.w3.org/2000/09/xmldsig#";
// ETSI EN 319 132-1 §4.1 and its predecessor, ETSI TS 101 903.
const XADES_NAMESPACES = new Set([
  "http://uri.etsi.org/01903/v1.3.2#",
  "http://uri.etsi.org/01903/v1.4.1#",
]);
// Certificate references elsewhere, such as complete certificate references,
// name issuers rather than the signer.
const SIGNING_CERTIFICATE_ELEMENTS = new Set([
  "SigningCertificate",
  "SigningCertificateV2",
]);
const MAX_CERTIFICATE_BYTES = 64 * 1024;

// XML Signature digest method identifiers, as base64 digests of DER bytes.
const DIGESTS = new Map<string, (bytes: Uint8Array) => string>([
  [
    "http://www.w3.org/2000/09/xmldsig#sha1",
    (bytes) => new Bun.CryptoHasher("sha1").update(bytes).digest("base64"),
  ],
  ["http://www.w3.org/2001/04/xmlenc#sha256", sha256Base64],
  [
    "http://www.w3.org/2001/04/xmldsig-more#sha384",
    (bytes) => new Bun.CryptoHasher("sha384").update(bytes).digest("base64"),
  ],
  [
    "http://www.w3.org/2001/04/xmlenc#sha512",
    (bytes) => new Bun.CryptoHasher("sha512").update(bytes).digest("base64"),
  ],
]);

export type XadesSigner = { id: string; name: string | null };

export const childElements = (
  node: DocumentXmlNode,
  namespaceURI: string,
  localName: string,
) =>
  node.children.filter(
    (child) =>
      child.localName === localName && child.namespaceURI === namespaceURI,
  );

const isXmlSignature = (node: DocumentXmlNode) =>
  node.namespaceURI === XMLDSIG_NAMESPACE && node.localName === "Signature";

/**
 * Matching elements in document order, not descending into a match or into a
 * nested XML signature, such as a countersignature, unless that is the match.
 */
const descendantElements = (
  node: DocumentXmlNode,
  matches: (node: DocumentXmlNode) => boolean,
): DocumentXmlNode[] => {
  const found: DocumentXmlNode[] = [];
  const pending = node.children.toReversed();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (matches(next)) {
      found.push(next);
    } else if (!isXmlSignature(next)) {
      pending.push(...next.children.toReversed());
    }
  }
  return found;
};

/** The XML signatures in a document, outermost only. */
export const xmlSignatures = (root: DocumentXmlNode) =>
  isXmlSignature(root) ? [root] : descendantElements(root, isXmlSignature);

const strictBase64 = /^[A-Za-z0-9+/]*={0,2}$/u;

/** Decodes XML Schema base64Binary, whose lexical form allows whitespace. */
export const decodeXmlBase64 = (text: string): Uint8Array | null => {
  const compact = text.replace(/[\t\n\r ]+/gu, "");
  return compact.length % 4 === 0 && strictBase64.test(compact)
    ? new Uint8Array(Buffer.from(compact, "base64"))
    : null;
};

const decodeCertificate = (node: DocumentXmlNode) => {
  if (node.text.length > (MAX_CERTIFICATE_BYTES * 4) / 3 + 1024) {
    return null;
  }
  const der = decodeXmlBase64(node.text);
  if (der === null || der.byteLength === 0) {
    return null;
  }
  const certificate = Result.try(() => pkijs.Certificate.fromBER(der));
  return certificate.isOk() ? { der, certificate: certificate.value } : null;
};

type SigningCertificateDigest = {
  algorithm: (bytes: Uint8Array) => string;
  value: string;
};

const signingCertificateDigests = (
  signature: DocumentXmlNode,
): SigningCertificateDigest[] =>
  descendantElements(
    signature,
    (node) =>
      XADES_NAMESPACES.has(node.namespaceURI) &&
      SIGNING_CERTIFICATE_ELEMENTS.has(node.localName),
  )
    .flatMap((element) =>
      descendantElements(
        element,
        (node) =>
          XADES_NAMESPACES.has(node.namespaceURI) &&
          node.localName === "CertDigest",
      ),
    )
    .flatMap((digest) => {
      const method = digest.children.find(
        (child) => child.localName === "DigestMethod",
      );
      const value = digest.children.find(
        (child) => child.localName === "DigestValue",
      );
      const algorithm = DIGESTS.get(method?.attributes.get("Algorithm") ?? "");
      return algorithm === undefined || value === undefined
        ? []
        : [{ algorithm, value: value.text.replace(/\s+/gu, "") }];
    });

/**
 * The stated signer of each XML signature: the certificate its XAdES signing
 * certificate digest names, else the only certificate in its key information.
 * Nothing here verifies a signature, a digest over signed data, or a chain.
 */
export const readXadesSigners = (
  signatures: readonly DocumentXmlNode[],
  idPrefix: string,
  /** A name the container itself states, used when no certificate names one. */
  statedName: (signature: DocumentXmlNode) => string | undefined = () =>
    undefined,
): XadesSigner[] =>
  signatures.map((signature, position) => {
    const certificates = descendantElements(
      signature,
      (node) =>
        node.namespaceURI === XMLDSIG_NAMESPACE &&
        node.localName === "X509Certificate",
    )
      .map(decodeCertificate)
      .filter((certificate) => certificate !== null);
    const digests = signingCertificateDigests(signature);
    const named = certificates.filter(({ der }) =>
      digests.some(({ algorithm, value }) => algorithm(der) === value),
    );
    // A stated digest that matches nothing names no one.
    const [signer] =
      digests.length === 0 && certificates.length === 1 ? certificates : named;
    return {
      id: `${idPrefix}-${position}`,
      name:
        (signer ? nameAttribute(signer.certificate.subject) : null) ??
        signerDisplayName(statedName(signature) ?? ""),
    };
  });
