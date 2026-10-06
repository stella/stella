import { QueryClient } from "@tanstack/react-query";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";

import { Temporal } from "@stll/time";

import type { LawRecentEntry } from "@/lib/law-search-history";

const local = new Map<string, string>();
const memoryStorage = {
  get length() {
    return local.size;
  },
  clear: () => local.clear(),
  getItem: (key: string) => local.get(key) ?? null,
  key: (index: number) => [...local.keys()].at(index) ?? null,
  removeItem: (key: string) => {
    local.delete(key);
  },
  setItem: (key: string, value: string) => {
    local.set(key, value);
  },
};
Object.assign(globalThis, { localStorage: memoryStorage });

const {
  clearLawRecent,
  filterLawRecent,
  lawRecentKey,
  readLawRecent,
  recordLawOpen,
  recordLawSearch,
  removeLawRecent,
} = await import("@/lib/law-search-history");
const { installUserScopedStorage } =
  await import("@/lib/account/install-user-scoped-storage");
const { releaseUserStorage, userStorageKey } =
  await import("@/lib/account/user-scoped-storage");

const queryClient = new QueryClient();
const storageAreas = () => ({ local: memoryStorage, session: null });
const uninstallStorage = installUserScopedStorage(queryClient, storageAreas);
let ownerNumber = 0;
const changeOwner = (id: string) => {
  queryClient.setQueryData(["session"], { user: { id } });
};
const at = (seconds: number) =>
  Temporal.Instant.from("2026-01-01T00:00:00Z")
    .add({ seconds })
    .toString({ fractionalSecondDigits: 3 });
const clock = spyOn(Temporal.Now, "instant");
const setTime = (seconds: number) => {
  clock.mockReturnValue(Temporal.Instant.from(at(seconds)));
};
const saved = () =>
  readLawRecent(local.get(userStorageKey("law_search_history")) ?? null);
const opened = (kind: "decision" | "statute", id = "shared-id") => ({
  kind,
  id,
  title: `Synthetic ${kind} ${id}`,
  path:
    kind === "decision"
      ? `/law/cz/cases/synthetic-court/${id}`
      : `/law/cz/statutes/${id}`,
});

beforeEach(() => {
  local.clear();
  ownerNumber += 1;
  changeOwner(`synthetic-owner-${ownerNumber}`);
  clearLawRecent();
  setTime(0);
});
afterEach(() => {
  clock.mockReset();
});
afterAll(() => {
  clock.mockRestore();
  uninstallStorage();
});

describe("browser-local law activity", () => {
  test("records trimmed searches and opened items with their reopen metadata", () => {
    recordLawSearch("  synthetic query  ");
    recordLawSearch(" \t ");
    setTime(1);
    recordLawOpen(opened("decision"));
    setTime(2);
    recordLawOpen(opened("statute"));

    expect(saved()).toEqual([
      { ...opened("statute"), at: at(2) },
      { ...opened("decision"), at: at(1) },
      { kind: "search", query: "synthetic query", at: at(0) },
    ]);
  });

  test("deduplicates within each kind and refreshes the newest title and time", () => {
    recordLawSearch("shared-id");
    recordLawOpen(opened("decision"));
    recordLawOpen(opened("statute"));
    setTime(5);
    recordLawOpen({ ...opened("decision"), title: "Updated synthetic title" });
    setTime(6);
    recordLawSearch(" shared-id ");

    expect(saved()).toEqual([
      { kind: "search", query: "shared-id", at: at(6) },
      { ...opened("decision"), title: "Updated synthetic title", at: at(5) },
      { ...opened("statute"), at: at(0) },
    ]);
  });

  test("keeps the newest fifty of every kind independently", () => {
    for (let index = 0; index < 55; index += 1) {
      setTime(index);
      recordLawSearch(`query-${index}`);
      recordLawOpen(opened("decision", `item-${index}`));
      recordLawOpen(opened("statute", `item-${index}`));
    }

    const entries = saved();
    expect(entries).toHaveLength(150);
    for (const kind of new Set(entries.map((entry) => entry.kind))) {
      const filtered = filterLawRecent(entries, kind);
      expect(filtered).toHaveLength(50);
      expect(filtered.at(0)?.at).toBe(at(54));
      expect(filtered.at(-1)?.at).toBe(at(5));
      expect(new Set(filtered.map(lawRecentKey)).size).toBe(50);
    }
    expect(entries.map((entry) => entry.at)).toEqual(
      entries
        .map((entry) => entry.at)
        .toSorted()
        .toReversed(),
    );
  });

  test("removes only the selected kind and clears the complete recent list", () => {
    recordLawSearch("shared-id");
    recordLawOpen(opened("decision"));
    recordLawOpen(opened("statute"));
    removeLawRecent({ ...opened("decision"), at: at(0) });
    expect(saved().map(lawRecentKey)).toEqual([
      "statute:shared-id",
      "search:shared-id",
    ]);
    clearLawRecent();
    expect(local.get(userStorageKey("law_search_history"))).toBe("[]");
    recordLawSearch("after-clear");
    expect(saved()).toEqual([
      { kind: "search", query: "after-clear", at: at(0) },
    ]);
  });

  test("isolates user-to-user and user-to-visitor transitions in the real store", () => {
    recordLawSearch("owner-a-query");
    recordLawOpen(opened("decision", "owner-a-item"));
    const firstKey = userStorageKey("law_search_history");
    const secondOwner = `synthetic-next-${ownerNumber}`;
    const secondKey = userStorageKey("law_search_history", {
      kind: "user",
      userId: secondOwner,
    });
    local.set(
      secondKey,
      JSON.stringify([{ ...opened("statute", "owner-b-item"), at: at(0) }]),
    );
    changeOwner(secondOwner);
    recordLawSearch("owner-b-query");
    expect(saved().map(lawRecentKey)).toEqual([
      "search:owner-b-query",
      "statute:owner-b-item",
    ]);
    expect(local.has(firstKey)).toBe(false);

    releaseUserStorage(storageAreas());
    recordLawSearch("visitor-query");
    expect(saved().map(lawRecentKey)).toEqual(["search:visitor-query"]);
    expect(local.has(secondKey)).toBe(false);
    changeOwner(`synthetic-return-${ownerNumber}`);
    recordLawOpen(opened("decision", "new-owner-item"));
    expect(saved().map(lawRecentKey)).toEqual(["decision:new-owner-item"]);
    expect(local.has("law_search_history:visitor")).toBe(false);
  });

  test("hydrates legacy owner-scoped searches and persists their migrated shape on write", () => {
    const nextOwner = `synthetic-migration-${ownerNumber}`;
    const key = userStorageKey("law_search_history", {
      kind: "user",
      userId: nextOwner,
    });
    local.set(
      key,
      JSON.stringify([{ query: " legacy synthetic query ", at: at(0) }]),
    );
    changeOwner(nextOwner);
    setTime(1);
    recordLawOpen(opened("statute"));
    expect(saved()).toEqual([
      { ...opened("statute"), at: at(1) },
      { kind: "search", query: "legacy synthetic query", at: at(0) },
    ]);
  });
});

describe("stored recent activity validation", () => {
  test("retains valid neighbors while dropping malformed rows and unsafe reopen links", () => {
    const valid = { ...opened("decision"), at: at(0) };
    const invalidRows = [
      null,
      false,
      "bad row",
      { kind: "search", query: "", at: at(0) },
      { kind: "search", query: "synthetic", at: "invalid time" },
      { kind: "unknown", query: "must not become legacy", at: at(0) },
      { ...valid, id: "" },
      { ...valid, title: "" },
      ...[
        "https://example.com",
        "//example.com",
        "/settings",
        "/law/cz/cases/synthetic-court/..",
        "/law/cz/cases/synthetic-court/%2e%2e",
        "/law/cz/cases/synthetic-court/item?redirect=https://example.com",
        "/law/cz/cases/synthetic-court/item#fragment",
        "/law/cz/cases/synthetic-court/item\\tail",
      ].map((path) => ({ ...valid, path })),
    ];
    expect(
      readLawRecent(
        JSON.stringify([
          invalidRows.at(0),
          valid,
          ...invalidRows.slice(1),
          { query: " legacy query ", at: at(1) },
        ]),
      ),
    ).toEqual([{ kind: "search", query: "legacy query", at: at(1) }, valid]);
  });

  test("retains public case and statute links containing compact UUID suffixes", () => {
    const entries = [
      {
        ...opened("decision"),
        path: "/law/cz/cases/synthetic-court/synthetic-case--AZ3UffUHfIS4J5gK8RuJgA",
        at: at(1),
      },
      {
        ...opened("statute"),
        path: "/law/cz/statutes/synthetic-statute--AZ3UffUHfIS4J5gK8RuJgA",
        at: at(0),
      },
    ];
    expect(readLawRecent(JSON.stringify(entries))).toEqual(entries);
  });

  test("treats invalid JSON and non-array payloads as empty", () => {
    for (const raw of [null, "{", "null", "{}", "42", '"text"']) {
      expect(readLawRecent(raw)).toEqual([]);
    }
  });

  test("sorts by instants across offsets and keeps the newest duplicate", () => {
    expect(
      readLawRecent(
        JSON.stringify([
          {
            kind: "search",
            query: "duplicate",
            at: "2026-01-01T10:00:00+02:00",
          },
          { query: "duplicate", at: "2026-01-01T09:00:00Z" },
          { ...opened("statute"), at: "2026-01-01T10:30:00+02:00" },
        ]),
      ),
    ).toEqual([
      { kind: "search", query: "duplicate", at: "2026-01-01T09:00:00Z" },
      { ...opened("statute"), at: "2026-01-01T10:30:00+02:00" },
    ]);
  });

  test("filters all supported kinds without changing order or entries", () => {
    const entries = [
      { kind: "search", query: "synthetic", at: at(2) },
      { ...opened("decision"), at: at(1) },
      { ...opened("statute"), at: at(0) },
    ] satisfies LawRecentEntry[];
    expect(filterLawRecent(entries, "all")).toBe(entries);
    expect(filterLawRecent(entries, "search").map(lawRecentKey)).toEqual([
      "search:synthetic",
    ]);
    expect(filterLawRecent(entries, "decision").map(lawRecentKey)).toEqual([
      "decision:shared-id",
    ]);
    expect(filterLawRecent(entries, "statute").map(lawRecentKey)).toEqual([
      "statute:shared-id",
    ]);
    expect(filterLawRecent([], "all")).toEqual([]);
  });
});
