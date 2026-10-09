import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  LAW_HISTORY_STORAGE_KEY,
  localHistoryImportEntries,
  migrateLocalLawHistory,
  readLawRecent,
} from "./law-search-history.logic";

const kept = JSON.stringify([
  { query: "náhrada škody", at: "2026-01-01T12:00:00Z" },
  {
    kind: "decision",
    id: "decision-1",
    title: "23 Cdo 1001/2021",
    path: "/law/cz/cases/supreme/decision-1",
    at: "2026-01-02T12:00:00Z",
    courtId: "court-1",
    documentIdentity: {
      kind: "decision",
      courtAbbreviation: "NS",
      courtTier: "supreme",
    },
  },
  {
    kind: "statute",
    id: "statute-1",
    title: "Act",
    path: "/law/cz/statutes/statute-1",
    at: "2026-01-03T12:00:00Z",
    documentIdentity: { kind: "statute", number: "172", year: "2026" },
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
    documentIdentity: {
      kind: "decision",
      courtAbbreviation: "NS",
      courtTier: "supreme",
    },
  });
  expect(batches.at(0)?.at(2)?.entry).toMatchObject({
    documentIdentity: { kind: "statute", number: "172", year: "2026" },
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
    documentIdentity: { kind: "unknown" },
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

test("local import converts legacy identity fields to the canonical identity contract", () => {
  const imports = localHistoryImportEntries([
    JSON.stringify([
      {
        kind: "decision",
        id: "legacy-decision",
        title: "Decision",
        path: "/law/cz/cases/supreme/legacy-decision",
        at: "2026-01-01T12:00:00Z",
        courtId: null,
        courtAbbreviation: "NS",
        courtTier: null,
      },
      {
        kind: "statute",
        id: "legacy-statute",
        title: "Act",
        path: "/law/cz/statutes/legacy-statute",
        at: "2026-01-01T12:00:00Z",
        statuteNumber: "172",
        statuteYear: "2026",
      },
    ]),
  ]);
  expect(imports.at(0)?.entry).toMatchObject({
    documentIdentity: { kind: "decision", courtAbbreviation: "NS" },
  });
  expect(imports.at(1)?.entry).toMatchObject({
    documentIdentity: { kind: "statute", number: "172", year: "2026" },
  });
  const decision = imports.at(0)?.entry;
  if (decision?.kind === "decision") {
    expect("courtTier" in decision.documentIdentity).toBe(false);
  }
});

test("a kept identity of the wrong document kind imports as unknown without discarding the row", () => {
  const rows = localHistoryImportEntries([
    JSON.stringify([
      {
        kind: "decision",
        id: "decision",
        title: "Decision",
        path: "/law/cz/cases/supreme/decision",
        at: "2026-01-01T12:00:00Z",
        documentIdentity: { kind: "statute", number: "172", year: "2026" },
      },
      {
        kind: "statute",
        id: "statute",
        title: "Act",
        path: "/law/cz/statutes/statute",
        at: "2026-01-01T12:00:00Z",
        documentIdentity: { kind: "decision", courtAbbreviation: "NS" },
      },
    ]),
  ]);
  expect(rows).toHaveLength(2);
  expect(rows.map(({ entry }) => entry)).toMatchObject([
    { documentIdentity: { kind: "unknown" } },
    { documentIdentity: { kind: "unknown" } },
  ]);
});
