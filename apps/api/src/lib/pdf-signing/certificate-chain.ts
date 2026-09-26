/**
 * The signer's issuer chain, completed on the server.
 *
 * The desktop hands over whatever chain its keychain could build without
 * going to the network, which for a card or a freshly imported certificate
 * is often just the leaf. A signature whose chain stops short cannot carry
 * long-term validation data, so phase 1 completes it here: issuers the
 * desktop sent are used when they verify, and a missing one is fetched from
 * the certificate's own AIA caIssuers URL through the guarded PKI fetcher.
 *
 * Only certificates that actually issued the one below them (matching name
 * and a verifying signature) join the chain, in order, leaf excluded. Extra
 * certificates the desktop sent are dropped: they would only inflate the
 * signature.
 */

import * as asn1js from "asn1js";
import { Result } from "better-result";
import * as pkijs from "pkijs";

import { safePkiFetch, withFetchBudget } from "@/api/lib/pdf-signing/pki-fetch";
import type { PkiFetcher } from "@/api/lib/pdf-signing/pki-fetch";

/** RFC 5280 id-pe-authorityInfoAccess. */
const AUTHORITY_INFO_ACCESS_OID = "1.3.6.1.5.5.7.1.1";
/** RFC 5280 id-ad-caIssuers. */
export const CA_ISSUERS_ACCESS_METHOD = "1.3.6.1.5.5.7.48.2";
/** RFC 5280 id-ad-ocsp. */
export const OCSP_ACCESS_METHOD = "1.3.6.1.5.5.7.48.1";
/** RFC 5280 id-ce-basicConstraints and id-ce-keyUsage. */
const BASIC_CONSTRAINTS_OID = "2.5.29.19";
const KEY_USAGE_OID = "2.5.29.15";
/** KeyUsage keyCertSign (bit 5) in the first content byte. */
const KEY_CERT_SIGN = 0x04;
/** RFC 5280 id-ce-cRLDistributionPoints. */
const CRL_DISTRIBUTION_POINTS_OID = "2.5.29.31";
/** RFC 5652 id-signedData, the wrapper a `.p7c` issuer bundle arrives in. */
const SIGNED_DATA_OID = "1.2.840.113549.1.7.2";
/** GeneralName CHOICE tag for uniformResourceIdentifier. */
const GENERAL_NAME_URI = 6;

/** Leaf excluded; deeper hierarchies than this do not occur in practice. */
const MAX_CHAIN_LENGTH = 6;
/** A certificate names one or two issuer URLs; more is not worth trying. */
const MAX_URLS_PER_CERTIFICATE = 2;
const ISSUER_MAX_BYTES = 64 * 1024;
/** Phase 1 runs while the desktop waits; issuer downloads get this long. */
const ISSUER_FETCH_BUDGET_MS = 20_000;

export const parseCertificate = (der: Uint8Array): pkijs.Certificate | null =>
  Result.try(() => pkijs.Certificate.fromBER(new Uint8Array(der))).unwrapOr(
    null,
  );

const derOf = (certificate: pkijs.Certificate) =>
  new Uint8Array(certificate.toSchema().toBER(false));

const extensionValue = (certificate: pkijs.Certificate, oid: string) =>
  certificate.extensions?.find((extension) => extension.extnID === oid)
    ?.extnValue.valueBlock.valueHexView;

const uriOf = (name: pkijs.GeneralName) =>
  name.type === GENERAL_NAME_URI && typeof name.value === "string"
    ? name.value
    : null;

/** The URIs an AIA extension lists for one access method. */
export const accessLocations = (
  certificate: pkijs.Certificate,
  accessMethod: string,
): string[] => {
  const value = extensionValue(certificate, AUTHORITY_INFO_ACCESS_OID);
  if (value === undefined) {
    return [];
  }
  return Result.try(() =>
    pkijs.InfoAccess.fromBER(new Uint8Array(value))
      .accessDescriptions.filter(
        (description) => description.accessMethod === accessMethod,
      )
      .map((description) => uriOf(description.accessLocation))
      .filter((uri) => uri !== null)
      .slice(0, MAX_URLS_PER_CERTIFICATE),
  ).unwrapOr([]);
};

/** The URIs a CRL distribution points extension lists. */
export const crlDistributionPoints = (
  certificate: pkijs.Certificate,
): string[] => {
  const value = extensionValue(certificate, CRL_DISTRIBUTION_POINTS_OID);
  if (value === undefined) {
    return [];
  }
  return Result.try(() =>
    pkijs.CRLDistributionPoints.fromBER(new Uint8Array(value))
      .distributionPoints.flatMap((point) =>
        Array.isArray(point.distributionPoint) ? point.distributionPoint : [],
      )
      .map(uriOf)
      .filter((uri) => uri !== null)
      .slice(0, MAX_URLS_PER_CERTIFICATE),
  ).unwrapOr([]);
};

const isSelfIssued = (certificate: pkijs.Certificate) =>
  certificate.subject.isEqual(certificate.issuer);

const extension = (certificate: pkijs.Certificate, oid: string) =>
  certificate.extensions?.find(({ extnID }) => extnID === oid);

/** RFC 5280 4.2.1.9: whether this is a CA, and how deep below it may go. */
const basicConstraints = (certificate: pkijs.Certificate) => {
  const value = extension(certificate, BASIC_CONSTRAINTS_OID)?.extnValue
    .valueBlock.valueHexView;
  if (value === undefined) {
    return null;
  }
  return Result.try(() => {
    const parsed = pkijs.BasicConstraints.fromBER(new Uint8Array(value));
    const { pathLenConstraint } = parsed;
    let pathLength: number | undefined;
    if (typeof pathLenConstraint === "number") {
      pathLength = pathLenConstraint;
    } else if (pathLenConstraint instanceof asn1js.Integer) {
      pathLength = pathLenConstraint.valueBlock.valueDec;
    }
    return { ca: parsed.cA === true, pathLength };
  }).unwrapOr(null);
};

/**
 * RFC 5280 6.1.4 (k, n): only a CA certificate whose key may sign
 * certificates can issue one. An absent KeyUsage leaves the key
 * unconstrained.
 */
const mayIssueCertificates = (certificate: pkijs.Certificate) => {
  if (basicConstraints(certificate)?.ca !== true) {
    return false;
  }
  const keyUsage = extension(certificate, KEY_USAGE_OID)?.extnValue.valueBlock
    .valueHexView;
  if (keyUsage === undefined) {
    return true;
  }
  return Result.try(() => {
    const bits = asn1js.fromBER(new Uint8Array(keyUsage)).result;
    if (!(bits instanceof asn1js.BitString)) {
      return false;
    }
    const firstByte = bits.valueBlock.valueHexView.at(0) ?? 0;
    return firstByte % (KEY_CERT_SIGN * 2) >= KEY_CERT_SIGN;
  }).unwrapOr(false);
};

const issued = async (
  issuer: pkijs.Certificate,
  subject: pkijs.Certificate,
): Promise<boolean> => {
  if (!subject.issuer.isEqual(issuer.subject)) {
    return false;
  }
  // A self-signed certificate vouches for itself; anyone else must be a CA.
  if (issuer !== subject && !mayIssueCertificates(issuer)) {
    return false;
  }
  const verified = await Result.tryPromise(
    async () => await subject.verify(issuer),
  );
  return verified.unwrapOr(false);
};

const isValidAt = (certificate: pkijs.Certificate, at: Date) =>
  certificate.notBefore.value.getTime() <= at.getTime() &&
  at.getTime() <= certificate.notAfter.value.getTime();

/**
 * Whether `chain` (the end-entity certificate first, then its issuers) is a
 * certification path to one of `anchors`, valid at `at` (RFC 5280 6.1):
 * every certificate up to the anchor is inside its validity window, each
 * issuer is a CA allowed to sign certificates and within its path length,
 * and each link's name and signature chain to the next. An anchor that is
 * the end-entity certificate itself pins exactly that certificate.
 */
export const certificationPathReachesAnchor = async ({
  anchors,
  at,
  chain,
}: {
  anchors: readonly Uint8Array[];
  at: Date;
  chain: readonly Uint8Array[];
}): Promise<boolean> => {
  const anchorIndex = chain.findIndex((certificate) =>
    anchors.some((anchor) =>
      Buffer.from(anchor).equals(Buffer.from(certificate)),
    ),
  );
  if (anchorIndex === -1) {
    return false;
  }
  const path = chain.slice(0, anchorIndex + 1).map(parseCertificate);
  if (!path.every((certificate) => certificate !== null)) {
    return false;
  }
  if (!path.every((certificate) => isValidAt(certificate, at))) {
    return false;
  }
  for (let index = 1; index < path.length; index += 1) {
    const issuer = path[index];
    const subject = path[index - 1];
    if (issuer === undefined || subject === undefined) {
      return false;
    }
    if (!(await issued(issuer, subject))) {
      return false;
    }
    // Intermediate CAs between this issuer and the end entity; a
    // self-issued one does not count against the length (6.1.4 l).
    const below = path
      .slice(1, index)
      .filter((certificate) => !isSelfIssued(certificate)).length;
    const pathLength = basicConstraints(issuer)?.pathLength;
    if (pathLength !== undefined && below > pathLength) {
      return false;
    }
  }
  return true;
};

/**
 * Certificates in an issuer download: a bare DER certificate, or a
 * certs-only PKCS#7 bundle.
 */
const certificatesIn = (bytes: Uint8Array): pkijs.Certificate[] => {
  const single = parseCertificate(bytes);
  if (single !== null) {
    return [single];
  }
  return Result.try((): pkijs.Certificate[] => {
    const asn1 = asn1js.fromBER(new Uint8Array(bytes));
    const contentInfo = new pkijs.ContentInfo({ schema: asn1.result });
    if (contentInfo.contentType !== SIGNED_DATA_OID) {
      return [];
    }
    const signedData = new pkijs.SignedData({ schema: contentInfo.content });
    return (signedData.certificates ?? []).filter(
      (entry) => entry instanceof pkijs.Certificate,
    );
  }).unwrapOr([]);
};

const findIssuer = async (
  subject: pkijs.Certificate,
  candidates: readonly pkijs.Certificate[],
) => {
  for (const candidate of candidates) {
    if (await issued(candidate, subject)) {
      return candidate;
    }
  }
  return null;
};

const fetchIssuer = async (subject: pkijs.Certificate, fetcher: PkiFetcher) => {
  for (const url of accessLocations(subject, CA_ISSUERS_ACCESS_METHOD)) {
    const bytes = await fetcher({
      maxBytes: ISSUER_MAX_BYTES,
      method: "GET",
      url,
    });
    const issuer =
      bytes === null ? null : await findIssuer(subject, certificatesIn(bytes));
    if (issuer !== null) {
      return issuer;
    }
  }
  return null;
};

export type CompletedCertificateChain = {
  /** Issuers above the leaf, innermost first. */
  chain: Uint8Array[];
  /** Whether the chain reaches a self-signed root. */
  complete: boolean;
};

export const completeCertificateChain = async ({
  candidates,
  certificate,
  fetcher = withFetchBudget(safePkiFetch, ISSUER_FETCH_BUDGET_MS),
}: {
  candidates: readonly Uint8Array[];
  certificate: Uint8Array;
  fetcher?: PkiFetcher;
}): Promise<CompletedCertificateChain> => {
  const leaf = parseCertificate(certificate);
  if (leaf === null) {
    return { chain: [], complete: false };
  }
  const offered = candidates
    .map(parseCertificate)
    .filter((entry) => entry !== null);

  const chain: Uint8Array[] = [];
  const seen = new Set([Buffer.from(certificate).toString("hex")]);
  let current = leaf;
  while (chain.length < MAX_CHAIN_LENGTH) {
    if (isSelfIssued(current) && (await issued(current, current))) {
      return { chain, complete: true };
    }
    const issuer =
      (await findIssuer(current, offered)) ??
      (await fetchIssuer(current, fetcher));
    if (issuer === null) {
      break;
    }
    const issuerDer = derOf(issuer);
    const issuerKey = Buffer.from(issuerDer).toString("hex");
    // An issuer already in the chain is a loop a misconfigured AIA pointer
    // produced; stop rather than walk it.
    if (seen.has(issuerKey)) {
      break;
    }
    seen.add(issuerKey);
    chain.push(issuerDer);
    current = issuer;
  }
  return { chain, complete: false };
};

/**
 * Whether a stored chain ends at a self-signed root. Phase 1 verified every
 * link, so a name comparison is enough to re-derive what it found.
 */
export const chainReachesRoot = (
  certificate: Uint8Array,
  chain: readonly Uint8Array[],
): boolean => {
  const top = parseCertificate(chain.at(-1) ?? certificate);
  return top !== null && isSelfIssued(top);
};
