// PKCE (RFC 7636) helpers for the loopback authorization-code flow.
//
// Mirrors the existing repo convention for PKCE generation
// (`apps/api/src/handlers/mcp-connectors/oauth.ts`'s `createPkce`): random
// bytes via Web Crypto, S256 challenge via `node:crypto` `createHash` so the
// published CLI runs under plain Node (Bun executes `node:*` natively).

import { createHash } from "node:crypto";

const VERIFIER_BYTES = 32;
const STATE_BYTES = 32;

const randomBase64Url = (byteLength: number): string => {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
};

export type PkcePair = {
  readonly codeVerifier: string;
  readonly codeChallenge: string;
};

/** Generates a fresh PKCE verifier/challenge pair (S256). */
export const createPkcePair = (): PkcePair => {
  const codeVerifier = randomBase64Url(VERIFIER_BYTES);
  const codeChallenge = generateCodeChallenge(codeVerifier);
  return { codeChallenge, codeVerifier };
};

/** Derives the S256 code challenge for a given verifier (exported for tests/vectors). */
export const generateCodeChallenge = (codeVerifier: string): string =>
  createHash("sha256").update(codeVerifier).digest("base64url");

/** Generates a random `state` parameter used to bind the callback to this login attempt. */
export const createOAuthState = (): string => randomBase64Url(STATE_BYTES);
