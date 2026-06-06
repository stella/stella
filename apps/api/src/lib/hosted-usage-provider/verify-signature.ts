/**
 * Hosted usage webhook signature verification.
 *
 * The provider follows the Standard Webhook spec
 * (https://github.com/standard-webhooks/standard-webhooks). Each
 * delivery carries three headers:
 *
 *   webhook-id          unique delivery ID (also the dedup key)
 *   webhook-timestamp   unix seconds, used for replay protection
 *   webhook-signature   one or more `v1,<base64-hmac>` entries
 *                       separated by spaces (allows secret rotation)
 *
 * The HMAC is SHA-256 over the literal string
 *
 *   `${id}.${timestamp}.${rawBody}`
 *
 * with the webhook secret as the key, base64-encoded.
 *
 * This module exposes a single `verifyWebhookSignature()` that
 * returns a discriminated result. The caller (the receive handler)
 * is responsible for choosing the HTTP status — we never throw, so
 * a bug in the verifier can never crash the request thread.
 */

import { timingSafeEqual } from "node:crypto";

const SIGNATURE_SCHEME = "v1";
const TOLERANCE_SECONDS = 5 * 60;

export type VerifyResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "missing_headers"
        | "malformed_timestamp"
        | "stale_timestamp"
        | "no_matching_signature";
    };

type VerifyInput = {
  /**
   * One or more secrets to test against. Multiple is used during
   * a rotation window so deliveries signed with either the
   * current or the previous secret are accepted.
   */
  secrets: readonly string[];
  rawBody: string;
  headers: {
    id: string | null;
    timestamp: string | null;
    signature: string | null;
  };
  /**
   * Override "now" for tests. Defaults to wall-clock seconds.
   */
  nowSeconds?: number;
};

export const verifyWebhookSignature = ({
  secrets,
  rawBody,
  headers,
  nowSeconds = Math.floor(Date.now() / 1000),
}: VerifyInput): VerifyResult => {
  if (!headers.id || !headers.timestamp || !headers.signature) {
    return { ok: false, reason: "missing_headers" };
  }
  if (secrets.length === 0) {
    return { ok: false, reason: "no_matching_signature" };
  }

  const ts = Number.parseInt(headers.timestamp, 10);
  if (!Number.isFinite(ts) || `${ts}` !== headers.timestamp.trim()) {
    return { ok: false, reason: "malformed_timestamp" };
  }
  if (Math.abs(nowSeconds - ts) > TOLERANCE_SECONDS) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const payload = `${headers.id}.${headers.timestamp}.${rawBody}`;
  const candidates = parseSignatureHeader(headers.signature);

  for (const secret of secrets) {
    const expected = hmacBase64(secret, payload);
    for (const candidate of candidates) {
      if (constantTimeEqualBase64(expected, candidate)) {
        return { ok: true };
      }
    }
  }
  return { ok: false, reason: "no_matching_signature" };
};

const hmacBase64 = (secret: string, payload: string): string => {
  const hasher = new Bun.CryptoHasher("sha256", secret);
  hasher.update(payload);
  return hasher.digest("base64");
};

const parseSignatureHeader = (raw: string): string[] => {
  const entries = raw
    .split(/\s+/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const signatures: string[] = [];
  for (const entry of entries) {
    const [scheme, value] = entry.split(",", 2);
    if (scheme === SIGNATURE_SCHEME && value && value.length > 0) {
      signatures.push(value);
    }
  }
  return signatures;
};

const constantTimeEqualBase64 = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a, "base64");
  const bufB = Buffer.from(b, "base64");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
};
