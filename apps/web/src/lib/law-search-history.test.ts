import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

// The browser's storage for this file.
const local = new Map<string, string>();
const memoryStorage = {
  get length() {
    return local.size;
  },
  clear: () => {
    local.clear();
  },
  getItem: (key: string) => local.get(key) ?? null,
  key: (index: number) => [...local.keys()][index] ?? null,
  removeItem: (key: string) => {
    local.delete(key);
  },
  setItem: (key: string, value: string) => {
    local.set(key, value);
  },
};
Object.assign(globalThis, { localStorage: memoryStorage });

const { recordLawSearch } = await import("@/lib/law-search-history");
const { installUserScopedStorage } =
  await import("@/lib/account/user-scoped-storage");

const queries = (key: string): unknown[] => {
  const stored: unknown = JSON.parse(local.get(key) ?? "[]");
  return Array.isArray(stored)
    ? stored.map((entry: unknown) =>
        typeof entry === "object" && entry !== null && "query" in entry
          ? entry.query
          : null,
      )
    : [];
};

describe("law search history", () => {
  test("each owner has their own, read afresh when the owner changes", () => {
    const queryClient = new QueryClient();
    installUserScopedStorage(queryClient, () => ({
      local: memoryStorage,
      session: null,
    }));

    queryClient.setQueryData(["session"], { user: { id: "user-a" } });
    recordLawSearch("alpha");
    expect(queries("law_search_history:u:user-a")).toEqual(["alpha"]);

    queryClient.setQueryData(["session"], { user: { id: "user-b" } });
    recordLawSearch("beta");

    expect(queries("law_search_history:u:user-b")).toEqual(["beta"]);
    expect(local.has("law_search_history:u:user-a")).toBe(false);
  });
});
