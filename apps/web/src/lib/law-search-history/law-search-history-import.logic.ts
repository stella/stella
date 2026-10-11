import { panic } from "better-result";

import { SEARCH_HISTORY_IMPORT_MAX } from "@stll/api-contract/limits";
import { buildSearchHistoryTitle } from "@stll/api-contract/search-history-title";

import {
  LAW_HISTORY_STORAGE_KEY,
  readLawRecent,
} from "./law-search-history.logic";

// Kept apart from law-search-history.logic, which the account storage registry
// loads with the app shell; this one-shot import loads with the law pages.

/** The only local-storage read: hand kept entries to the server in one batch. */
export const localHistoryImportEntries = (values: readonly (string | null)[]) =>
  values.flatMap((raw) =>
    readLawRecent(raw).map((entry) => {
      const usedAt = entry.at;
      switch (entry.kind) {
        case "search":
          return { usedAt, entry: { kind: entry.kind, query: entry.query } };
        case "decision": {
          let documentIdentity = entry.documentIdentity;
          if (documentIdentity === undefined) {
            if (entry.courtAbbreviation === null) {
              documentIdentity = { kind: "unknown" };
            } else {
              documentIdentity =
                entry.courtTier === null
                  ? {
                      kind: "decision",
                      courtAbbreviation: entry.courtAbbreviation,
                    }
                  : {
                      kind: "decision",
                      courtAbbreviation: entry.courtAbbreviation,
                      courtTier: entry.courtTier,
                    };
            }
          }
          return {
            usedAt,
            entry: {
              kind: entry.kind,
              documentId: entry.id,
              title: buildSearchHistoryTitle({
                identifier: "",
                description: entry.title,
              }),
              path: entry.path,
              courtId: entry.courtId,
              documentIdentity,
            },
          };
        }
        case "statute": {
          const documentIdentity =
            entry.documentIdentity ??
            (entry.statuteNumber === null || entry.statuteYear === null
              ? { kind: "unknown" as const }
              : {
                  kind: "statute" as const,
                  number: entry.statuteNumber,
                  year: entry.statuteYear,
                });
          return {
            usedAt,
            entry: {
              kind: entry.kind,
              documentId: entry.id,
              title: buildSearchHistoryTitle({
                identifier: "",
                description: entry.title,
              }),
              path: entry.path,
              documentIdentity,
            },
          };
        }
        default:
          entry satisfies never;
          return panic("Unhandled local law history kind");
      }
    }),
  );

type ImportLocalHistoryOptions = {
  storage: Pick<Storage, "getItem" | "removeItem">;
  userKey: string;
  canRemove: () => boolean;
  importEntries: (
    entries: ReturnType<typeof localHistoryImportEntries>,
  ) => Promise<void>;
};

/** Keep both snapshots until every batch succeeds; retries replay idempotent imports. */
export const migrateLocalLawHistory = async ({
  storage,
  userKey,
  importEntries,
  canRemove,
}: ImportLocalHistoryOptions) => {
  const keys = [userKey, LAW_HISTORY_STORAGE_KEY];
  const raw = keys.map((key) => storage.getItem(key));
  if (raw.every((value) => value === null)) {
    return;
  }
  const entries = localHistoryImportEntries(raw);
  for (
    let offset = 0;
    offset < entries.length;
    offset += SEARCH_HISTORY_IMPORT_MAX
  ) {
    await importEntries(
      entries.slice(offset, offset + SEARCH_HISTORY_IMPORT_MAX),
    );
  }
  if (!canRemove()) {
    return;
  }
  for (const [index, key] of keys.entries()) {
    if (storage.getItem(key) === raw.at(index)) {
      storage.removeItem(key);
    }
  }
};
