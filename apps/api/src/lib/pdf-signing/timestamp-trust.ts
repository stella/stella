/**
 * Which timestamp authorities' time is trusted.
 *
 * A token that verifies only proves some key signed it. Whether that key's
 * time counts is the operator's decision: `PDF_SIGNING_TSA_TRUST_PEM` holds
 * the trust anchors, as PEM text or a path to a PEM file. An anchor may be a
 * root or intermediate CA, or a timestamp authority's own certificate to pin
 * exactly that authority. With no anchor configured, or a token whose chain
 * reaches none (see `certificationPathReachesAnchor`), the timestamp is
 * still embedded but not counted as trusted time. No anchors ship with stella: trust lists differ by jurisdiction.
 */

import { Result } from "better-result";
import { readFileSync } from "node:fs";

import { env } from "@/api/env";
import { parseCertificate } from "@/api/lib/pdf-signing/certificate-chain";

const PEM_CERTIFICATE =
  /-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+?)-----END CERTIFICATE-----/gu;

/** The certificates in PEM text, DER; blocks that do not parse are skipped. */
export const parseTrustAnchors = (pem: string): Uint8Array[] =>
  [...pem.matchAll(PEM_CERTIFICATE)]
    .map(([, body]) => new Uint8Array(Buffer.from(body ?? "", "base64")))
    .filter((der) => der.byteLength > 0 && parseCertificate(der) !== null);

/**
 * The configured anchors. A value holding a PEM block is the bundle itself;
 * anything else is read as a path. An unreadable path yields no anchors, so
 * a misconfiguration fails closed: timestamps are embedded, not trusted.
 */
export const configuredTimestampTrustAnchors = (
  value: string | undefined = env.PDF_SIGNING_TSA_TRUST_PEM,
): Uint8Array[] => {
  if (value === undefined || value.trim() === "") {
    return [];
  }
  if (value.includes("-----BEGIN CERTIFICATE-----")) {
    return parseTrustAnchors(value);
  }
  return Result.try(() =>
    parseTrustAnchors(readFileSync(value.trim(), "utf-8")),
  ).unwrapOr([]);
};
