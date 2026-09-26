/**
 * Revocation data for long-term validation, fetched through the guarded PKI
 * fetcher.
 *
 * LibPDF's own provider fetches with the global `fetch`, which would let a
 * certificate's OCSP or CRL URL reach any address the API can. This one
 * speaks the same interface over `safePkiFetch`, and remembers which
 * certificates it actually found revocation data for, so the caller can
 * tell B-LT (every certificate covered) from a signature that only claims
 * trusted time.
 */

import type { RevocationProvider } from "@libpdf/core";
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
/** Everything revocation checking may wait on in one signing. */
const REVOCATION_FETCH_BUDGET_MS = 25_000;
/** RFC 6960 OCSPResponseStatus successful. */
const OCSP_SUCCESSFUL = 0;

export type TrackedRevocationProvider = RevocationProvider & {
  /** Whether OCSP or CRL data was found for this certificate. */
  covers: (certificate: Uint8Array) => boolean;
};

const fingerprint = (der: Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(der).digest("hex");

const isSuccessfulOcspResponse = (bytes: Uint8Array) => {
  try {
    return (
      pkijs.OCSPResponse.fromBER(new Uint8Array(bytes)).responseStatus
        .valueBlock.valueDec === OCSP_SUCCESSFUL
    );
  } catch {
    return false;
  }
};

const isCertificateRevocationList = (bytes: Uint8Array) => {
  try {
    pkijs.CertificateRevocationList.fromBER(new Uint8Array(bytes));
    return true;
  } catch {
    return false;
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

  return {
    covers: (certificate) => covered.has(fingerprint(certificate)),

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
        if (response !== null && isSuccessfulOcspResponse(response)) {
          covered.add(fingerprint(certificateDer));
          return response;
        }
      }
      return null;
    },

    getCRL: async (certificateDer) => {
      const certificate = parseCertificate(certificateDer);
      if (certificate === null) {
        return null;
      }
      for (const url of crlDistributionPoints(certificate)) {
        const crl = await fetcher({
          maxBytes: CRL_MAX_BYTES,
          method: "GET",
          url,
        });
        if (crl !== null && isCertificateRevocationList(crl)) {
          covered.add(fingerprint(certificateDer));
          return crl;
        }
      }
      return null;
    },
  };
};
