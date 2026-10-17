import { useCallback } from "react";

import * as v from "valibot";

import { useOwnerScopedState } from "@/lib/account/use-owner-scoped-state";
import { userStorageKey } from "@/lib/account/user-scoped-storage";
import type { StorageOwner } from "@/lib/account/user-scoped-storage";
import {
  definePersistedState,
  keepInAnyScope,
  readPersistedState,
  writePersistedState,
} from "@/lib/persisted-state/registry";

const MIN_COL_WIDTH_PX = 80;
const MAX_COL_WIDTH_PX = 800;
const ColumnWidthsRecordSchema = v.record(v.string(), v.number());

type ColumnWidthScope = { baseKey: string; owner: StorageOwner };

const columnWidthsEntry = definePersistedState({
  key: ({ baseKey, owner }: ColumnWidthScope) => userStorageKey(baseKey, owner),
  area: "local",
  version: 1,
  schema: ColumnWidthsRecordSchema,
  maxBytes: 65_536,
  defaultValue: () => ({}),
  scopeCheck: keepInAnyScope,
  restoredUi: true,
});

export const useColumnWidths = (baseKey: string) => {
  const read = useCallback(
    (owner: StorageOwner) =>
      readPersistedState(columnWidthsEntry, { baseKey, owner }),
    [baseKey],
  );
  const write = useCallback(
    (widths: Record<string, number>, owner: StorageOwner) => {
      writePersistedState(columnWidthsEntry, { baseKey, owner }, widths);
    },
    [baseKey],
  );
  const getDefaultValue = useCallback((): Record<string, number> => ({}), []);
  const { value: widths, updateValue } = useOwnerScopedState({
    read,
    write,
    getDefaultValue,
  });
  const setWidth = (id: string, width: number) => {
    const clamped = Math.max(
      MIN_COL_WIDTH_PX,
      Math.min(MAX_COL_WIDTH_PX, Math.round(width)),
    );
    updateValue((previous) =>
      previous[id] === clamped ? previous : { ...previous, [id]: clamped },
    );
  };
  return { widths, setWidth };
};
