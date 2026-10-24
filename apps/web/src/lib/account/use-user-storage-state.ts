import { browserStateStorage } from "@/lib/account/browser-storage";
import type { StorageArea } from "@/lib/account/storage-families";
import { useOwnerScopedState } from "@/lib/account/use-owner-scoped-state";
import { userStorageKey } from "@/lib/account/user-scoped-storage";
import type { StorageOwner } from "@/lib/account/user-scoped-storage";

type UserStorageStateOptions<T> = {
  baseKey: string;
  area: StorageArea;
  decode: (raw: string | null) => T;
  encode: (value: T) => string;
};

export const useUserStorageState = <T>({
  baseKey,
  area,
  decode,
  encode,
}: UserStorageStateOptions<T>) => {
  const read = (owner: StorageOwner) =>
    decode(browserStateStorage(area).getItem(userStorageKey(baseKey, owner)));
  const write = (value: T, owner: StorageOwner) =>
    browserStateStorage(area).setItem(
      userStorageKey(baseKey, owner),
      encode(value),
    );
  const getDefaultValue = () => decode(null);
  return useOwnerScopedState({ read, write, getDefaultValue });
};
