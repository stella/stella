import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  LAW_HISTORY_STORAGE_KEY,
  localHistoryImportEntries,
  migrateLocalLawHistory,
  readLawRecent,
} from "./law-search-history";

const kept = JSON.stringify([
  { query: "náhrada škody", at: "2026-01-01T12:00:00Z" },
  {
    kind: "decision",
    id: "decision-1",
    title: "23 Cdo 1001/2021",
    path: "/law/cz/cases/supreme/decision-1",
    at: "2026-01-02T12:00:00Z",
    courtId: "court-1",
    courtAbbreviation: "NS",
    courtTier: "supreme",
  },
  {
    kind: "statute",
    id: "statute-1",
    title: "Act",
    path: "/law/cz/statutes/statute-1",
    at: "2026-01-03T12:00:00Z",
    statuteNumber: "172",
    statuteYear: "2026",
  },
]);
const storageFor = () => {
  const values = new Map([
    ["owner-key", kept],
    [LAW_HISTORY_STORAGE_KEY, kept],
  ]);
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
};

test("one batch imports both local keys with decision and statute identity then stops reading local history", async () => {
  const storage = storageFor();
  const batches: ReturnType<typeof localHistoryImportEntries>[] = [];
  const importEntries = async (
    entries: ReturnType<typeof localHistoryImportEntries>,
  ) => {
    batches.push(entries);
  };
  await migrateLocalLawHistory({
    storage,
    userKey: "owner-key",
    canRemove: () => true,
    importEntries,
  });
  await migrateLocalLawHistory({
    storage,
    userKey: "owner-key",
    canRemove: () => true,
    importEntries,
  });
  expect(batches).toHaveLength(1);
  expect(batches.at(0)).toHaveLength(6);
  expect(batches.at(0)?.at(1)?.entry).toMatchObject({
    courtId: "court-1",
    courtAbbreviation: "NS",
  });
  expect(batches.at(0)?.at(2)?.entry).toMatchObject({
    statuteNumber: "172",
    statuteYear: "2026",
  });
  expect(storage.values.size).toBe(0);
});

test("failed batch keeps both local keys available for a later import", async () => {
  const storage = storageFor();
  expect(
    await rejectionOf(
      migrateLocalLawHistory({
        storage,
        userKey: "owner-key",
        canRemove: () => true,
        importEntries: async () => {
          throw new TypeError("offline");
        },
      }),
    ),
  ).toMatchObject({ message: "offline" });
  expect(storage.values.size).toBe(2);
});

test("local import preserves all undeleted rows and skips invalid links individually", () => {
  const rows = Array.from({ length: 70 }, (_, index) => ({
    query: `search ${index}`,
    at: "2026-01-01T12:00:00Z",
  }));
  rows.push({ query: "", at: "invalid" });
  expect(readLawRecent(JSON.stringify(rows))).toHaveLength(70);
  expect(
    localHistoryImportEntries([
      JSON.stringify([
        {
          kind: "decision",
          id: "bad",
          title: "bad",
          path: "https://example.com",
          at: "2026-01-01T12:00:00Z",
        },
      ]),
    ]),
  ).toEqual([]);
});

test("local entries without identity import explicit unknown identity", () => {
  const entry = localHistoryImportEntries([
    JSON.stringify([
      {
        kind: "decision",
        id: "decision-2",
        title: "Decision",
        path: "/law/cz/cases/unknown/decision-2",
        at: "2026-01-01T12:00:00Z",
      },
    ]),
  ]).at(0);
  expect(entry?.entry).toMatchObject({
    courtId: null,
    courtAbbreviation: null,
    courtTier: null,
  });
});

test("an import completed after its owner changed preserves the local batch", async () => {
  const storage = storageFor();
  let currentScope = true;
  await migrateLocalLawHistory({
    storage,
    userKey: "owner-key",
    canRemove: () => currentScope,
    importEntries: async () => {
      currentScope = false;
    },
  });
  expect(storage.values.size).toBe(2);
});
