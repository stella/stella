import {
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  getItemAsync,
  setItemAsync,
} from "expo-secure-store";

import { dictationPreferences } from "./preferences";

export type { AudioChoice, DictationAction } from "./preferences";

const options = { keychainAccessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
export const { loadChoice, rememberChoice } = dictationPreferences({
  read: async (key) => await getItemAsync(key, options),
  write: async (key, value) => {
    await setItemAsync(key, value, options);
  },
});
