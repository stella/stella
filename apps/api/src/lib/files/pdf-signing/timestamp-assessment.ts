/**
 * What a validated timestamp token is worth: whether its time is trusted and
 * whether its authority's chain is complete enough to validate long term.
 * The signature's timestamp and the archival document timestamp are judged
 * the same way.
 */

import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import {
  certificationPathReachesAnchor,
  completeCertificateChain,
} from "@/api/lib/files/pdf-signing/certificate-chain";
import type { PkiFetcher } from "@/api/lib/files/pdf-signing/pki-fetch";
import type { ValidatedTimestamp } from "@/api/lib/files/pdf-signing/timestamp-token";
import { anchorsForTimestamp } from "@/api/lib/files/pdf-signing/timestamp-trust";
import type { TimestampTrust } from "@/api/lib/files/pdf-signing/timestamp-trust";

type TimestampAssessment = {
  /** The token's signing certificate first, then its issuers. */
  chain: Uint8Array[];
  /** Whether `chain` reaches a self-signed root. */
  complete: boolean;
  /** Whether `chain` reaches a trust anchor at the token's time. */
  trusted: boolean;
};

/**
 * Complete the authority's chain from the trust anchors, what the token
 * carries and its issuers' AIA URLs (through the guarded fetcher), then
 * check it against the anchors at the token's generation time.
 *
 * Anchors come first: tokens often carry their root cross-signed by an
 * older one (DigiCert Trusted Root G4 under Assured ID, Sectigo's R46 under
 * USERTrust), and a chain built through that copy would end above the
 * anchor instead of at it.
 */
export const assessTimestamp = async ({
  fetcher,
  permit,
  timestamp,
  trust,
}: {
  /** Issuer downloads; the guarded PKI fetcher when omitted. */
  fetcher?: PkiFetcher;
  permit: ThirdPartyOutboundPermit;
  timestamp: ValidatedTimestamp;
  trust: TimestampTrust;
}): Promise<TimestampAssessment> => {
  const issuers = await completeCertificateChain({
    permit,
    candidates: [...trust.anchors, ...timestamp.certificates],
    certificate: timestamp.signerCertificate,
    ...(fetcher !== undefined && { fetcher }),
  });
  const chain = [timestamp.signerCertificate, ...issuers.chain];
  return {
    chain,
    complete: issuers.complete,
    trusted: await certificationPathReachesAnchor({
      anchors: anchorsForTimestamp(trust, timestamp.signerCertificate),
      at: timestamp.genTime,
      chain,
    }),
  };
};
