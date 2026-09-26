/**
 * Revocation data for the signer's chain, fetched through the guarded PKI
 * fetcher.
 *
 * Two answers come out of it. Whether each certificate is covered by
 * revocation data (B-LT needs every one), and whether any is revoked, which
 * ends the signing outright: a revoked certificate must never sign.
 *
 * Only authentic, current data about this exact certificate counts. An OCSP
 * response must be signed by the issuer or by a responder the issuer
 * delegated (id-kp-OCSPSigning), name the certificate's CertID and be inside
 * its validity window; a CRL must be the issuer's, verify against it and be
 * current. Anything else is ignored as unavailable, never read as "good".
 * No nonce is sent (most responders serve pre-signed responses), so
 * freshness rests on the validity window.
 */

import { Result } from "better-result";
import * as pkijs from "pkijs";

import { DAY_IN_MS } from "@stll/time";

import {
  accessLocations,
  carriedCertificates,
  crlDistributionPoints,
  OCSP_ACCESS_METHOD,
  parseCertificate,
} from "@/api/lib/files/pdf-signing/certificate-chain";
import {
  safePkiFetch,
  withFetchBudget,
} from "@/api/lib/files/pdf-signing/pki-fetch";
import type { PkiFetcher } from "@/api/lib/files/pdf-signing/pki-fetch";

const OCSP_RESPONSE_MAX_BYTES = 64 * 1024;
/** Large CAs publish multi-megabyte CRLs; past this the DSS would balloon. */
const CRL_MAX_BYTES = 4 * 1024 * 1024;
/** Everything revocation checking may wait on in one signing step. */
const REVOCATION_FETCH_BUDGET_MS = 25_000;
/** RFC 6960 OCSPResponseStatus successful. */
const OCSP_SUCCESSFUL = 0;
/** CertStatus CHOICE tags (RFC 6960 4.2.1): [0] good, [1] revoked. */
const OCSP_CERT_GOOD = 0;
const OCSP_CERT_REVOKED = 1;
/** RFC 6960 id-kp-OCSPSigning. */
const OCSP_SIGNING_USAGE = "1.3.6.1.5.5.7.3.9";
/** RFC 5280 id-ce-extKeyUsage. */
const EXTENDED_KEY_USAGE_OID = "2.5.29.37";
/** Clocks disagree; a response dated slightly ahead is still current. */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
/** A response or CRL that names no next update is current for this long. */
const MAX_UNDATED_AGE_MS = 7 * DAY_IN_MS;

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

/** Whether data dated `thisUpdate`..`nextUpdate` is current at `now`. */
export const isCurrent = (
  thisUpdate: Date,
  nextUpdate: Date | undefined,
  now: Date,
) =>
  thisUpdate.getTime() <= now.getTime() + MAX_CLOCK_SKEW_MS &&
  (nextUpdate === undefined
    ? thisUpdate.getTime() >= now.getTime() - MAX_UNDATED_AGE_MS
    : nextUpdate.getTime() >= now.getTime() - MAX_CLOCK_SKEW_MS);

/** A verification that throws (malformed key, unknown algorithm) failed. */
const settlesTrue = async (verification: Promise<boolean>) =>
  (await Result.tryPromise(async () => await verification)).unwrapOr(false);

const allowsOcspSigning = (certificate: pkijs.Certificate) => {
  const extension = certificate.extensions?.find(
    ({ extnID }) => extnID === EXTENDED_KEY_USAGE_OID,
  );
  if (extension === undefined) {
    return false;
  }
  return Result.try(() =>
    pkijs.ExtKeyUsage.fromBER(
      new Uint8Array(extension.extnValue.valueBlock.valueHexView),
    ).keyPurposes.includes(OCSP_SIGNING_USAGE),
  ).unwrapOr(false);
};

/** Whether a certificate is inside its validity window at `at`. */
const isValidAt = (certificate: pkijs.Certificate, at: Date) =>
  certificate.notBefore.value.getTime() <= at.getTime() + MAX_CLOCK_SKEW_MS &&
  certificate.notAfter.value.getTime() >= at.getTime() - MAX_CLOCK_SKEW_MS;

/**
 * Whether the response is signed by the issuer itself, or by a responder
 * certificate it carries that the issuer signed, authorized for OCSP and
 * that is valid both when the response was produced and now. A delegate's
 * own revocation is not fetched: RFC 6960 4.2.2.2.1 leaves that to its
 * short lifetime (id-pkix-ocsp-nocheck), which is why its validity window
 * is the check that matters.
 */
const signedByAuthorizedResponder = async (
  basic: pkijs.BasicOCSPResponse,
  issuer: pkijs.Certificate,
  now: Date,
) => {
  const engine = pkijs.getCrypto(true);
  const delegates: pkijs.Certificate[] = [];
  for (const candidate of carriedCertificates(basic.certs)) {
    if (
      allowsOcspSigning(candidate) &&
      isValidAt(candidate, now) &&
      isValidAt(candidate, basic.tbsResponseData.producedAt) &&
      candidate.issuer.isEqual(issuer.subject) &&
      (await settlesTrue(candidate.verify(issuer)))
    ) {
      delegates.push(candidate);
    }
  }
  for (const signer of [issuer, ...delegates]) {
    const verified = await settlesTrue(
      engine.verifyWithPublicKey(
        basic.tbsResponseData.tbsView,
        basic.signature,
        signer.subjectPublicKeyInfo,
        basic.signatureAlgorithm,
      ),
    );
    if (verified) {
      return true;
    }
  }
  return false;
};

/** 0 good, 1 revoked, 2 unknown; `null` when not an answer about it. */
const ocspStatus = async (
  bytes: Uint8Array,
  certificate: pkijs.Certificate,
  issuer: pkijs.Certificate,
  now: Date,
): Promise<number | null> => {
  const status = await Result.tryPromise(async (): Promise<number | null> => {
    const response = pkijs.OCSPResponse.fromBER(new Uint8Array(bytes));
    const encoded = response.responseBytes?.response.valueBlock.valueHexView;
    if (
      response.responseStatus.valueBlock.valueDec !== OCSP_SUCCESSFUL ||
      encoded === undefined
    ) {
      return null;
    }
    const basic = pkijs.BasicOCSPResponse.fromBER(new Uint8Array(encoded));
    if (!(await signedByAuthorizedResponder(basic, issuer, now))) {
      return null;
    }
    const engine = pkijs.getCrypto(true);
    for (const single of basic.tbsResponseData.responses) {
      const certID = new pkijs.CertID();
      await certID.createForCertificate(certificate, {
        hashAlgorithm: engine.getAlgorithmByOID(
          single.certID.hashAlgorithm.algorithmId,
          true,
          "CertID.hashAlgorithm",
        ).name,
        issuerCertificate: issuer,
      });
      if (
        single.certID.isEqual(certID) &&
        isCurrent(single.thisUpdate, single.nextUpdate, now)
      ) {
        return single.certStatus.idBlock.tagNumber;
      }
    }
    return null;
  });
  return status.unwrapOr(null);
};

/** Whether `bytes` is a current CRL `issuer` signed, and what it says. */
const crlVerdict = async (
  bytes: Uint8Array,
  certificate: pkijs.Certificate,
  issuer: pkijs.Certificate,
  now: Date,
): Promise<"good" | "revoked" | null> => {
  const verdict = await Result.tryPromise(
    async (): Promise<"good" | "revoked" | null> => {
      const crl = pkijs.CertificateRevocationList.fromBER(
        new Uint8Array(bytes),
      );
      if (
        !crl.issuer.isEqual(issuer.subject) ||
        !isCurrent(crl.thisUpdate.value, crl.nextUpdate?.value, now) ||
        !(await crl.verify({ issuerCertificate: issuer }))
      ) {
        return null;
      }
      return crl.isCertificateRevoked(certificate) ? "revoked" : "good";
    },
  );
  return verdict.unwrapOr(null);
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
  now: () => Date = () => new Date(),
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
            : await ocspStatus(response, certificate, issuer, now());
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
          crl === null
            ? null
            : await crlVerdict(crl, certificate, issuer, now());
        if (crl !== null && verdict !== null) {
          record(certificateDer, verdict);
          return crl;
        }
      }
      return null;
    },
  };
};
