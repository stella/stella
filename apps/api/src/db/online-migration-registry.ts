import { panic } from "better-result";

import * as entryModules from "./online-migration-entries.gen";
import type { OnlineMigrationEntry } from "./online-migration-entry";

export const orderOnlineMigrationEntries = (
  entries: readonly OnlineMigrationEntry[],
): readonly OnlineMigrationEntry[] => {
  const ordered = entries.toSorted(
    (left, right) => left.revision - right.revision,
  );
  const ids = new Set<string>();
  const revisions = new Set<number>();
  for (const entry of ordered) {
    if (
      !entry.id ||
      !Number.isSafeInteger(entry.revision) ||
      entry.revision <= 0
    ) {
      panic(
        "Online migration entries require an id, positive integer revision",
      );
    }
    if (ids.has(entry.id) || revisions.has(entry.revision)) {
      panic("Online migration entry ids and revisions must be unique");
    }
    ids.add(entry.id);
    revisions.add(entry.revision);
  }
  return ordered;
};

export const ONLINE_MIGRATION_ENTRIES = orderOnlineMigrationEntries(
  Object.values(entryModules),
);
