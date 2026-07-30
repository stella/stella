import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * Better Auth persists bearer-session cookies under this prefix. Bind it to the
 * complete normalized API base URL so changing either server origin or a
 * self-hosted path prefix cannot carry credentials into another deployment.
 */
export const mobileAuthStoragePrefix = (apiUrl: string): string =>
  `stella-auth-${bytesToHex(sha256(utf8ToBytes(apiUrl)))}`;
