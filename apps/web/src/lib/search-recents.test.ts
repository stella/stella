import { describe, expect, test } from "bun:test";

import {
  readRecentFiles,
  readRecentSearches,
  recordRecentFile,
  recordRecentSearch,
} from "@/lib/search-recents";
import type { SearchRecentsScope } from "@/lib/search-recents";

class MemoryStorage implements Storage {
  readonly #items = new Map<string, string>();

  get length(): number {
    return this.#items.size;
  }

  clear(): void {
    this.#items.clear();
  }

  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#items.keys()].at(index) ?? null;
  }

  removeItem(key: string): void {
    this.#items.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#items.set(key, value);
  }
}

const scope: SearchRecentsScope = {
  organizationId: "org-1",
  userId: "user-1",
};

describe("search recents", () => {
  test("records recent searches newest first and dedupes exact queries", () => {
    const storage = new MemoryStorage();

    recordRecentSearch(" černý ", scope, storage);
    recordRecentSearch("agreement", scope, storage);
    recordRecentSearch("černý", scope, storage);

    expect(
      readRecentSearches(scope, storage).map((item) => item.query),
    ).toEqual(["černý", "agreement"]);
  });

  test("caps recent searches", () => {
    const storage = new MemoryStorage();

    for (const query of ["a", "b", "c", "d", "e", "f", "g"]) {
      recordRecentSearch(query, scope, storage);
    }

    expect(
      readRecentSearches(scope, storage).map((item) => item.query),
    ).toEqual(["g", "f", "e", "d", "c", "b"]);
  });

  test("records recent files newest first and dedupes by entity", () => {
    const storage = new MemoryStorage();

    recordRecentFile(
      {
        entityId: "entity-1",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        title: "Draft.docx",
        workspaceId: "workspace-1",
        workspaceName: "Matter A",
      },
      scope,
      storage,
    );
    recordRecentFile(
      {
        entityId: "entity-1",
        mimeType: "application/pdf",
        title: "Final.docx",
        workspaceId: "workspace-1",
        workspaceName: "Matter A",
      },
      scope,
      storage,
    );

    expect(
      readRecentFiles(scope, storage).map((item) => ({
        entityId: item.entityId,
        mimeType: item.mimeType,
        title: item.title,
      })),
    ).toEqual([
      {
        entityId: "entity-1",
        mimeType: "application/pdf",
        title: "Final.docx",
      },
    ]);
  });

  test("keeps older recent file records without MIME metadata", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      "stella-search-recent-files:org-1:user-1",
      JSON.stringify([
        {
          entityId: "entity-1",
          openedAt: new Date().toISOString(),
          title: "Legacy.pdf",
          workspaceId: "workspace-1",
          workspaceName: "Matter A",
        },
      ]),
    );

    expect(readRecentFiles(scope, storage).map((item) => item.title)).toEqual([
      "Legacy.pdf",
    ]);
  });

  test("scopes recents by organization and user", () => {
    const storage = new MemoryStorage();
    const otherScope: SearchRecentsScope = {
      organizationId: "org-2",
      userId: "user-1",
    };

    recordRecentSearch("privileged matter", scope, storage);

    expect(readRecentSearches(otherScope, storage)).toEqual([]);
    expect(
      readRecentSearches(scope, storage).map((item) => item.query),
    ).toEqual(["privileged matter"]);
  });

  test("ignores corrupted storage payloads", () => {
    const storage = new MemoryStorage();
    storage.setItem("stella-search-recent-searches:org-1:user-1", "{bad");
    storage.setItem(
      "stella-search-recent-files:org-1:user-1",
      JSON.stringify([{ bad: true }]),
    );

    expect(readRecentSearches(scope, storage)).toEqual([]);
    expect(readRecentFiles(scope, storage)).toEqual([]);
  });
});
