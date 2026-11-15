import {
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  deleteItemAsync,
  getItemAsync,
  setItemAsync,
} from "expo-secure-store";

import type { AccountStore } from "@/state/recent-searches";

/**
 * The same keychain class the session lives in: readable once the device
 * has been unlocked after boot, and never restored onto another device from
 * a backup. Sign-out deletes what is kept here, since an iOS keychain item
 * outlives the app's removal.
 */
const KEYCHAIN = { keychainAccessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

/**
 * Every item this store touches lives under its own prefix, so no key it is
 * given can reach the session's item, which only `connection/platform.ts`
 * reads and writes (`session-ownership.test.ts` holds both files to it).
 */
const accountKey = (key: string): string => `stella.account.${key}`;

/** Small values the app keeps per account on this device, such as recent searches. */
export const deviceAccountStore: AccountStore = {
  read: async (key) => await getItemAsync(accountKey(key), KEYCHAIN),
  write: async (key, value) => {
    await setItemAsync(accountKey(key), value, KEYCHAIN);
  },
  remove: async (key) => {
    await deleteItemAsync(accountKey(key), KEYCHAIN);
  },
};
