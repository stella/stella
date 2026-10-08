import { useCallback } from "react";

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
  const read = useCallback(
    (owner: StorageOwner) =>
      decode(browserStateStorage(area).getItem(userStorageKey(baseKey, owner))),
    [area, baseKey, decode],
  );
  const write = useCallback(
    (value: T, owner: StorageOwner) =>
      browserStateStorage(area).setItem(
        userStorageKey(baseKey, owner),
        encode(value),
      ),
    [area, baseKey, encode],
  );
  const getDefaultValue = useCallback(() => decode(null), [decode]);
  return useOwnerScopedState({ read, write, getDefaultValue });
};
