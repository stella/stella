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
import * as pkijs from "pkijs";

import { safePkiFetch, withFetchBudget } from "@/api/lib/pdf-signing/pki-fetch";
import type { PkiFetcher } from "@/api/lib/pdf-signing/pki-fetch";

/** RFC 5280 id-pe-authorityInfoAccess. */
const AUTHORITY_INFO_ACCESS_OID = "1.3.6.1.5.5.7.1.1";
/** RFC 5280 id-ad-caIssuers. */
export const CA_ISSUERS_ACCESS_METHOD = "1.3.6.1.5.5.7.48.2";
/** RFC 5280 id-ad-ocsp. */
export const OCSP_ACCESS_METHOD = "1.3.6.1.5.5.7.48.1";
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

export const parseCertificate = (der: Uint8Array): pkijs.Certificate | null => {
  try {
    return pkijs.Certificate.fromBER(new Uint8Array(der));
  } catch {
    return null;
  }
};

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
  try {
    return pkijs.InfoAccess.fromBER(new Uint8Array(value))
      .accessDescriptions.filter(
        (description) => description.accessMethod === accessMethod,
      )
      .map((description) => uriOf(description.accessLocation))
      .filter((uri) => uri !== null)
      .slice(0, MAX_URLS_PER_CERTIFICATE);
  } catch {
    return [];
  }
};

/** The URIs a CRL distribution points extension lists. */
export const crlDistributionPoints = (
  certificate: pkijs.Certificate,
): string[] => {
  const value = extensionValue(certificate, CRL_DISTRIBUTION_POINTS_OID);
  if (value === undefined) {
    return [];
  }
  try {
    return pkijs.CRLDistributionPoints.fromBER(new Uint8Array(value))
      .distributionPoints.flatMap((point) =>
        Array.isArray(point.distributionPoint) ? point.distributionPoint : [],
      )
      .map(uriOf)
      .filter((uri) => uri !== null)
      .slice(0, MAX_URLS_PER_CERTIFICATE);
  } catch {
    return [];
  }
};

const isSelfIssued = (certificate: pkijs.Certificate) =>
  certificate.subject.isEqual(certificate.issuer);

const issued = async (
  issuer: pkijs.Certificate,
  subject: pkijs.Certificate,
): Promise<boolean> => {
  if (!subject.issuer.isEqual(issuer.subject)) {
    return false;
  }
  try {
    return await subject.verify(issuer);
  } catch {
    return false;
  }
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
  try {
    const asn1 = asn1js.fromBER(new Uint8Array(bytes));
    const contentInfo = new pkijs.ContentInfo({ schema: asn1.result });
    if (contentInfo.contentType !== SIGNED_DATA_OID) {
      return [];
    }
    const signedData = new pkijs.SignedData({ schema: contentInfo.content });
    return (signedData.certificates ?? []).filter(
      (entry) => entry instanceof pkijs.Certificate,
    );
  } catch {
    return [];
  }
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
