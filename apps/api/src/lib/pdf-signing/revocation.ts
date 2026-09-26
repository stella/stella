/**
 * Revocation data for the signer's chain, fetched through the guarded PKI
 * fetcher.
 *
 * Two answers come out of it. Whether each certificate is covered by
 * revocation data (B-LT needs every one), and whether any is revoked, which
 * ends the signing outright: a revoked certificate must never sign.
 *
 * Only a response that is about this exact certificate counts: an OCSP
 * response must name its CertID, and a CRL must verify against the issuer.
 * A response that cannot be tied to the certificate is ignored, never read
 * as "good".
 */

import * as pkijs from "pkijs";

import {
  accessLocations,
  crlDistributionPoints,
  OCSP_ACCESS_METHOD,
  parseCertificate,
} from "@/api/lib/pdf-signing/certificate-chain";
import { safePkiFetch, withFetchBudget } from "@/api/lib/pdf-signing/pki-fetch";
import type { PkiFetcher } from "@/api/lib/pdf-signing/pki-fetch";

const OCSP_RESPONSE_MAX_BYTES = 64 * 1024;
/** Large CAs publish multi-megabyte CRLs; past this the DSS would balloon. */
const CRL_MAX_BYTES = 4 * 1024 * 1024;
/** Everything revocation checking may wait on in one signing step. */
const REVOCATION_FETCH_BUDGET_MS = 25_000;
/** RFC 6960 OCSPResponseStatus successful. */
const OCSP_SUCCESSFUL = 0;
/** pkijs `getCertificateStatus`: 0 good, 1 revoked, 2 unknown. */
const OCSP_CERT_GOOD = 0;
const OCSP_CERT_REVOKED = 1;

export type TrackedRevocationProvider = {
  /** Whether revocation data says this certificate is not revoked. */
  covers: (certificate: Uint8Array) => boolean;
  /** A verified CRL from `certificate`'s distribution point, or `null`. */
  getCRL: (
    certificate: Uint8Array,
    issuer: Uint8Array | undefined,
  ) => Promise<Uint8Array | null>;
  /** An OCSP response about `certificate`, or `null`. */
  getOCSP: (
    certificate: Uint8Array,
    issuer: Uint8Array,
  ) => Promise<Uint8Array | null>;
  /** Whether revocation data says this certificate is revoked. */
  isRevoked: (certificate: Uint8Array) => boolean;
};

const fingerprint = (der: Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(der).digest("hex");

/** 0 good, 1 revoked, 2 unknown; `null` when not an answer about it. */
const ocspStatus = async (
  bytes: Uint8Array,
  certificate: pkijs.Certificate,
  issuer: pkijs.Certificate,
): Promise<number | null> => {
  try {
    const response = pkijs.OCSPResponse.fromBER(new Uint8Array(bytes));
    if (response.responseStatus.valueBlock.valueDec !== OCSP_SUCCESSFUL) {
      return null;
    }
    const status = await response.getCertificateStatus(certificate, issuer);
    return status.isForCertificate ? status.status : null;
  } catch {
    return null;
  }
};

/** Whether `bytes` is a CRL `issuer` signed, and what it says. */
const crlVerdict = async (
  bytes: Uint8Array,
  certificate: pkijs.Certificate,
  issuer: pkijs.Certificate,
): Promise<"good" | "revoked" | null> => {
  try {
    const crl = pkijs.CertificateRevocationList.fromBER(new Uint8Array(bytes));
    if (!(await crl.verify({ issuerCertificate: issuer }))) {
      return null;
    }
    return crl.isCertificateRevoked(certificate) ? "revoked" : "good";
  } catch {
    return null;
  }
};

const ocspRequestFor = async (
  certificate: pkijs.Certificate,
  issuer: pkijs.Certificate,
) => {
  const request = new pkijs.OCSPRequest();
  // SHA-1 CertIDs are what responders universally index by (RFC 5019).
  await request.createForCertificate(certificate, {
    hashAlgorithm: "SHA-1",
    issuerCertificate: issuer,
  });
  return new Uint8Array(request.toSchema(true).toBER(false));
};

export const createTrackedRevocationProvider = (
  fetcher: PkiFetcher = withFetchBudget(
    safePkiFetch,
    REVOCATION_FETCH_BUDGET_MS,
  ),
): TrackedRevocationProvider => {
  const covered = new Set<string>();
  const revoked = new Set<string>();
  const record = (certificateDer: Uint8Array, verdict: "good" | "revoked") =>
    (verdict === "revoked" ? revoked : covered).add(
      fingerprint(certificateDer),
    );

  return {
    covers: (certificate) => covered.has(fingerprint(certificate)),
    isRevoked: (certificate) => revoked.has(fingerprint(certificate)),

    getOCSP: async (certificateDer, issuerDer) => {
      const certificate = parseCertificate(certificateDer);
      const issuer = parseCertificate(issuerDer);
      if (certificate === null || issuer === null) {
        return null;
      }
      const urls = accessLocations(certificate, OCSP_ACCESS_METHOD);
      if (urls.length === 0) {
        return null;
      }
      const request = await ocspRequestFor(certificate, issuer);
      for (const url of urls) {
        const response = await fetcher({
          body: request,
          contentType: "application/ocsp-request",
          maxBytes: OCSP_RESPONSE_MAX_BYTES,
          method: "POST",
          url,
        });
        const status =
          response === null
            ? null
            : await ocspStatus(response, certificate, issuer);
        if (
          response !== null &&
          (status === OCSP_CERT_GOOD || status === OCSP_CERT_REVOKED)
        ) {
          record(
            certificateDer,
            status === OCSP_CERT_REVOKED ? "revoked" : "good",
          );
          return response;
        }
      }
      return null;
    },

    getCRL: async (certificateDer, issuerDer) => {
      const certificate = parseCertificate(certificateDer);
      const issuer =
        issuerDer === undefined ? null : parseCertificate(issuerDer);
      // Without the issuer a CRL cannot be verified, and an unverified list
      // proves nothing either way.
      if (certificate === null || issuer === null) {
        return null;
      }
      for (const url of crlDistributionPoints(certificate)) {
        const crl = await fetcher({
          maxBytes: CRL_MAX_BYTES,
          method: "GET",
          url,
        });
        const verdict =
          crl === null ? null : await crlVerdict(crl, certificate, issuer);
        if (crl !== null && verdict !== null) {
          record(certificateDer, verdict);
          return crl;
        }
      }
      return null;
    },
  };
};
