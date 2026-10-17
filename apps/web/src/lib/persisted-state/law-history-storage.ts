import * as v from "valibot";

import { readLawRecent } from "@/lib/law-search-history/law-search-history.rows";
import type { LawRecentEntry } from "@/lib/law-search-history/law-search-history.schema";
import {
  definePersistedState,
  keepInAnyScope,
  readPersistedState,
  removePersistedState,
  writePersistedState,
} from "@/lib/persisted-state/registry";

const lawHistoryEntry = definePersistedState({
  key: ({ key }: { key: string }) => key,
  area: "local",
  version: 1,
  schema: v.array(v.unknown()),
  maxBytes: 1_048_576,
  defaultValue: () => [],
  scopeCheck: keepInAnyScope,
  restoredUi: false,
});

export const readLocalLawHistory = (key: string): readonly LawRecentEntry[] =>
  readLawRecent(JSON.stringify(readPersistedState(lawHistoryEntry, { key })));

export const writeLocalLawHistory = (
  key: string,
  entries: readonly LawRecentEntry[],
): void => {
  writePersistedState(lawHistoryEntry, { key }, [...entries]);
};

export const removeLocalLawHistory = (key: string): void => {
  removePersistedState(lawHistoryEntry, { key });
};

export const lawHistoryMigrationStorage: Pick<
  Storage,
  "getItem" | "removeItem"
> = {
  getItem: (key) => JSON.stringify(readLocalLawHistory(key)),
  removeItem: removeLocalLawHistory,
};
