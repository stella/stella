// PKCE (RFC 7636) for the authorization-code flow. Randomness and hashing
// come from the platform: Hermes has no Web Crypto, so the app passes
// expo-crypto and tests pass Bun's Web Crypto.

export type AuthorizationCrypto = {
  readonly randomBytes: (length: number) => Uint8Array;
  readonly sha256: (input: Uint8Array<ArrayBuffer>) => Promise<Uint8Array>;
};

/** 32 bytes encode to the 43-character verifier RFC 7636 §4.1 recommends. */
const VERIFIER_BYTES = 32;
const STATE_BYTES = 32;

/** RFC 4648 §5 base64url without padding. */
export const encodeBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");

export type PkcePair = {
  readonly codeVerifier: string;
  readonly codeChallenge: string;
};

/** The S256 challenge for a verifier. */
export const deriveCodeChallenge = async (
  crypto: AuthorizationCrypto,
  codeVerifier: string,
): Promise<string> =>
  encodeBase64Url(await crypto.sha256(new TextEncoder().encode(codeVerifier)));

export const createPkcePair = async (
  crypto: AuthorizationCrypto,
): Promise<PkcePair> => {
  const codeVerifier = encodeBase64Url(crypto.randomBytes(VERIFIER_BYTES));
  return {
    codeVerifier,
    codeChallenge: await deriveCodeChallenge(crypto, codeVerifier),
  };
};

/** Binds a callback to the one sign-in attempt that started it. */
export const createAuthorizationState = (crypto: AuthorizationCrypto): string =>
  encodeBase64Url(crypto.randomBytes(STATE_BYTES));
