import {
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  getItemAsync,
  setItemAsync,
} from "expo-secure-store";

import type { AccountStore } from "@/state/recent-searches";

/**
 * The same keychain the session lives in: readable once the device has been
 * unlocked after boot, and never restored onto another device from a backup.
 */
const KEYCHAIN = { keychainAccessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

/** Small values the app keeps per account on this device, such as recent searches. */
export const deviceAccountStore: AccountStore = {
  read: async (key) => await getItemAsync(key, KEYCHAIN),
  write: async (key, value) => {
    await setItemAsync(key, value, KEYCHAIN);
  },
};
