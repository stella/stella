// The device side of the connection layer. Everything else in `connection/`
// takes these as parameters, so it runs unchanged under Bun.

import { CryptoDigestAlgorithm, digest, getRandomBytes } from "expo-crypto";
import {
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  deleteItemAsync,
  getItemAsync,
  setItemAsync,
} from "expo-secure-store";
import { openAuthSessionAsync } from "expo-web-browser";
import * as v from "valibot";

import type { AuthorizationCrypto } from "./pkce";
import { createSessionStore, storedSessionSchema } from "./session";
import type { OpenAuthSession } from "./sign-in";

export const deviceCrypto: AuthorizationCrypto = {
  randomBytes: getRandomBytes,
  sha256: async (input) =>
    new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, input)),
};

const SESSION_KEY = "stella.session";

/**
 * The Keychain on iOS, the Keystore-encrypted store on Android. Readable once
 * the device has been unlocked after boot, so a refresh can run in the
 * background, and never restored onto another device from a backup.
 */
const KEYCHAIN = { keychainAccessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

export const deviceSessionStore = createSessionStore({
  read: async () => {
    const stored = await getItemAsync(SESSION_KEY, KEYCHAIN);
    if (stored === null) {
      return undefined;
    }
    const parsed = v.safeParse(
      v.pipe(v.string(), v.parseJson(), storedSessionSchema),
      stored,
    );
    // A shape this build cannot read is a session it cannot use; dropping it
    // sends the person to sign in rather than failing every request.
    if (!parsed.success) {
      await deleteItemAsync(SESSION_KEY, KEYCHAIN);
      return undefined;
    }
    return parsed.output;
  },
  write: async (session) => {
    await setItemAsync(SESSION_KEY, JSON.stringify(session), KEYCHAIN);
  },
  clear: async () => {
    await deleteItemAsync(SESSION_KEY, KEYCHAIN);
  },
});

/**
 * The system authentication session (ASWebAuthenticationSession, Custom Tabs).
 * The app never sees the password; on iOS the session hands only this
 * attempt's redirect back to the app.
 */
export const openDeviceAuthSession: OpenAuthSession = async (
  authorizeUrl,
  redirectUri,
) => {
  const result = await openAuthSessionAsync(authorizeUrl, redirectUri);
  return result.type === "success"
    ? { type: "success", url: result.url }
    : { type: "cancel" };
};
