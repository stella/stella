import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { env } from "@/api/env";

/**
 * Confirmation-token handshake for the email feedback channel.
 *
 * The github channel needs no token: nothing is published until the human opens
 * the prefilled issue URL and submits it themselves. The email channel has no
 * such intrinsic gate, so a first `send_feedback` call returns a signed token
 * bound to the exact sanitized content, and only a second, deliberate call that
 * echoes the same content plus that token actually sends the email. The token
 * is an HMAC over the content hash and an expiry, keyed by the server's own
 * auth secret, so it cannot be forged or replayed against different content.
 */

const TOKEN_VERSION_TAG = "stella-feedback-v1";

export const FEEDBACK_TOKEN_TTL_MINUTES = 15;
const FEEDBACK_TOKEN_TTL_MS = FEEDBACK_TOKEN_TTL_MINUTES * 60 * 1000;

export type FeedbackTokenContent = {
  channel: string;
  kind: string;
  sanitizedTitle: string;
  sanitizedBody: string;
};

const serializeContent = (content: FeedbackTokenContent): string =>
  JSON.stringify([
    content.channel,
    content.kind,
    content.sanitizedTitle,
    content.sanitizedBody,
  ]);

/** SHA-256 of the exact content the token authorizes, hex-encoded. */
const contentHash = ({
  channel,
  kind,
  sanitizedBody,
  sanitizedTitle,
}: FeedbackTokenContent): string =>
  createHash("sha256")
    .update(serializeContent({ channel, kind, sanitizedTitle, sanitizedBody }))
    .digest("hex");

const sign = (contentDigest: string, expiresAtMs: number): string =>
  createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update(`${TOKEN_VERSION_TAG}\n${contentDigest}\n${expiresAtMs}`)
    .digest("hex");

/** Token format: `<expiresAtMs>.<hex hmac>`. */
export const createFeedbackToken = (
  content: FeedbackTokenContent,
  nowMs: number = Date.now(),
): string => {
  const expiresAtMs = nowMs + FEEDBACK_TOKEN_TTL_MS;
  const mac = sign(contentHash(content), expiresAtMs);
  return `${expiresAtMs}.${mac}`;
};

/** Constant-time compare of two hex strings; false on any shape mismatch. */
const timingSafeEqualHex = (a: string, b: string): boolean => {
  const aBytes = Buffer.from(a, "hex");
  const bBytes = Buffer.from(b, "hex");
  if (aBytes.length === 0 || aBytes.length !== bBytes.length) {
    return false;
  }
  return timingSafeEqual(aBytes, bBytes);
};

/**
 * True only when `token` was issued by this server for exactly this content and
 * has not expired. Content tamper (kind/title/body) and expiry tamper both flip
 * the recomputed HMAC, so a mismatch fails closed.
 */
export const verifyFeedbackToken = ({
  nowMs = Date.now(),
  token,
  ...content
}: FeedbackTokenContent & { token: string; nowMs?: number }): boolean => {
  const separator = token.indexOf(".");
  if (separator <= 0) {
    return false;
  }
  const expiresAtMs = Number(token.slice(0, separator));
  const macHex = token.slice(separator + 1);
  if (!Number.isInteger(expiresAtMs) || expiresAtMs <= 0) {
    return false;
  }
  if (expiresAtMs < nowMs) {
    return false;
  }
  return timingSafeEqualHex(macHex, sign(contentHash(content), expiresAtMs));
};
