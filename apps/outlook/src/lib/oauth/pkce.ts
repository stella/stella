// PKCE (RFC 7636) and the `state` value for the authorization-code flow,
// from the browser's Web Crypto.

import { sha256Bytes } from "@stll/sha256/browser";

/** 32 bytes encode to the 43-character verifier RFC 7636 §4.1 recommends. */
const VERIFIER_BYTES = 32;
const STATE_BYTES = 32;

/** RFC 4648 §5 base64url without padding. */
export const encodeBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const randomBytes = (length: number): Uint8Array =>
  crypto.getRandomValues(new Uint8Array(length));

export type PkcePair = {
  readonly codeVerifier: string;
  readonly codeChallenge: string;
};

/** The S256 challenge for a verifier. */
export const deriveCodeChallenge = async (
  codeVerifier: string,
): Promise<string> =>
  encodeBase64Url(new Uint8Array(await sha256Bytes(codeVerifier)));

export const createPkcePair = async (): Promise<PkcePair> => {
  const codeVerifier = encodeBase64Url(randomBytes(VERIFIER_BYTES));
  return {
    codeVerifier,
    codeChallenge: await deriveCodeChallenge(codeVerifier),
  };
};

/** Binds a callback to the one sign-in attempt that started it. */
export const createAuthorizationState = (): string =>
  encodeBase64Url(randomBytes(STATE_BYTES));
