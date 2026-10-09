import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, test } from "bun:test";

import { installUserScopedStorage } from "@/lib/account/install-user-scoped-storage";
import {
  releaseUserStorage,
  storageOwner,
  userStorageKey,
} from "@/lib/account/user-scoped-storage";
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

let scope: SearchRecentsScope = {
  owner: storageOwner(),
  organizationId: "org-1",
  userId: "user-1",
};

beforeEach(() => {
  const queryClient = new QueryClient();
  const unsubscribe = installUserScopedStorage(queryClient, () => ({
    local: null,
    session: null,
  }));
  queryClient.setQueryData(["session"], { user: { id: "user-1" } });
  unsubscribe();
  scope = { owner: storageOwner(), organizationId: "org-1", userId: "user-1" };
});

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
        fileFieldId: "field-draft",
        filePropertyId: "property-file",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        title: "Draft.docx",
        updatedAt: "2021-01-01T00:00:00.000Z",
        workspaceId: "workspace-1",
        workspaceName: "Matter A",
      },
      scope,
      storage,
    );
    recordRecentFile(
      {
        entityId: "entity-1",
        fileFieldId: "field-final",
        filePropertyId: "property-file",
        mimeType: "application/pdf",
        title: "Final.docx",
        updatedAt: "2021-02-01T00:00:00.000Z",
        workspaceId: "workspace-1",
        workspaceName: "Matter A",
      },
      scope,
      storage,
    );

    expect(
      readRecentFiles(scope, storage).map((item) => ({
        entityId: item.entityId,
        fileFieldId: item.fileFieldId,
        filePropertyId: item.filePropertyId,
        mimeType: item.mimeType,
        title: item.title,
        updatedAt: item.updatedAt,
      })),
    ).toEqual([
      {
        entityId: "entity-1",
        fileFieldId: "field-final",
        filePropertyId: "property-file",
        mimeType: "application/pdf",
        title: "Final.docx",
        updatedAt: "2021-02-01T00:00:00.000Z",
      },
    ]);
  });

  test("keeps older recent file records without MIME metadata", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      userStorageKey("stella-search-recent-files:org-1:", {
        kind: "user",
        userId: "user-1",
      }),
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

  test("drops recent file records with empty identity fields", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      userStorageKey("stella-search-recent-files:org-1:", {
        kind: "user",
        userId: "user-1",
      }),
      JSON.stringify([
        {
          entityId: "",
          openedAt: new Date().toISOString(),
          title: "Missing entity.pdf",
          workspaceId: "workspace-1",
          workspaceName: "Matter A",
        },
        {
          entityId: "entity-1",
          openedAt: new Date().toISOString(),
          title: "Missing workspace.pdf",
          workspaceId: "",
          workspaceName: "Matter A",
        },
      ]),
    );

    expect(readRecentFiles(scope, storage)).toEqual([]);
  });

  test("does not overwrite recents with empty file identity fields", () => {
    const storage = new MemoryStorage();
    const validFile = {
      entityId: "entity-1",
      title: "Existing.pdf",
      workspaceId: "workspace-1",
      workspaceName: "Matter A",
    };
    recordRecentFile(validFile, scope, storage);
    const existing = readRecentFiles(scope, storage);

    expect(
      recordRecentFile({ ...validFile, entityId: "" }, scope, storage),
    ).toEqual(existing);
    expect(
      recordRecentFile({ ...validFile, workspaceId: "" }, scope, storage),
    ).toEqual(existing);
    expect(readRecentFiles(scope, storage)).toEqual(existing);
  });

  test("drops ill-formed resource identities at the storage boundary", () => {
    const storage = new MemoryStorage();
    const illFormedId = "\uD800";
    storage.setItem(
      userStorageKey("stella-search-recent-files:org-1:", {
        kind: "user",
        userId: "user-1",
      }),
      JSON.stringify([
        {
          entityId: illFormedId,
          openedAt: new Date().toISOString(),
          title: "Invalid entity.pdf",
          workspaceId: "workspace-1",
          workspaceName: "Matter A",
        },
        {
          entityId: "entity-1",
          openedAt: new Date().toISOString(),
          title: "Invalid workspace.pdf",
          workspaceId: illFormedId,
          workspaceName: "Matter A",
        },
      ]),
    );
    expect(readRecentFiles(scope, storage)).toEqual([]);

    const validFile = {
      entityId: "entity-1",
      title: "Existing.pdf",
      workspaceId: "workspace-1",
      workspaceName: "Matter A",
    };
    recordRecentFile(validFile, scope, storage);
    const existing = readRecentFiles(scope, storage);
    expect(
      recordRecentFile({ ...validFile, entityId: illFormedId }, scope, storage),
    ).toEqual(existing);
    expect(
      recordRecentFile(
        { ...validFile, workspaceId: illFormedId },
        scope,
        storage,
      ),
    ).toEqual(existing);
  });

  test("scopes recents by organization and user", () => {
    const storage = new MemoryStorage();
    const otherScope: SearchRecentsScope = {
      owner: scope.owner,
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
    storage.setItem(
      userStorageKey("stella-search-recent-searches:org-1:", {
        kind: "user",
        userId: "user-1",
      }),
      "{bad",
    );
    storage.setItem(
      userStorageKey("stella-search-recent-files:org-1:", {
        kind: "user",
        userId: "user-1",
      }),
      JSON.stringify([{ bad: true }]),
    );

    expect(readRecentSearches(scope, storage)).toEqual([]);
    expect(readRecentFiles(scope, storage)).toEqual([]);
  });
  test("captured recents follow the current owner across visitor, another user and return transitions", () => {
    const storage = new MemoryStorage();
    const areas = { local: storage, session: null };
    const queryClient = new QueryClient();
    const unsubscribe = installUserScopedStorage(queryClient, () => areas);
    const file = {
      entityId: "entity-1",
      title: "Draft.pdf",
      workspaceId: "workspace-1",
      workspaceName: "Matter A",
    };
    try {
      recordRecentSearch("account A", scope, storage);
      recordRecentFile(file, scope, storage);
      expect(
        readRecentSearches(scope, storage).map((item) => item.query),
      ).toEqual(["account A"]);
      expect(readRecentFiles(scope, storage).map((item) => item.title)).toEqual(
        ["Draft.pdf"],
      );

      for (const nextUserId of [null, "user-2", "user-1"]) {
        if (nextUserId === null) {
          releaseUserStorage(areas);
        } else {
          queryClient.setQueryData(["session"], { user: { id: nextUserId } });
        }
        expect(readRecentSearches(scope, storage)).toEqual([]);
        expect(readRecentFiles(scope, storage)).toEqual([]);
        expect(recordRecentSearch("delayed account A", scope, storage)).toEqual(
          [],
        );
        expect(recordRecentFile(file, scope, storage)).toEqual([]);
        // Only user-1's own searches wait for them; the files list (fetched
        // organization data) is gone.
        expect(
          Array.from({ length: storage.length }, (_, index) =>
            storage.key(index),
          ),
        ).toEqual(["stella-search-recent-searches:org-1::u:user-1"]);
      }

      const refreshedScope = {
        owner: storageOwner(),
        organizationId: scope.organizationId,
        userId: scope.userId,
      };
      expect(
        recordRecentSearch("fresh account A", refreshedScope, storage).map(
          (item) => item.query,
        ),
      ).toEqual(["fresh account A", "account A"]);
      expect(
        recordRecentFile(file, refreshedScope, storage).map(
          (item) => item.title,
        ),
      ).toEqual(["Draft.pdf"]);
    } finally {
      unsubscribe();
    }
  });

  test("an outdated owner scope does not read retained entries", () => {
    const storage = new MemoryStorage();
    recordRecentSearch("account A", scope, storage);
    recordRecentFile(
      {
        entityId: "entity-1",
        title: "Draft.pdf",
        workspaceId: "workspace-1",
        workspaceName: "Matter A",
      },
      scope,
      storage,
    );
    const queryClient = new QueryClient();
    const unsubscribe = installUserScopedStorage(queryClient, () => ({
      local: null,
      session: null,
    }));
    queryClient.setQueryData(["session"], { user: { id: "user-2" } });
    unsubscribe();
    expect(storage.length).toBe(2);
    expect(readRecentSearches(scope, storage)).toEqual([]);
    expect(readRecentFiles(scope, storage)).toEqual([]);
  });

  test("an auth scope that differs from the current storage owner cannot read or write recents", () => {
    const storage = new MemoryStorage();
    const mismatchedScope = {
      owner: storageOwner(),
      organizationId: scope.organizationId,
      userId: "user-2",
    };
    const file = {
      entityId: "entity-1",
      title: "Draft.pdf",
      workspaceId: "workspace-1",
      workspaceName: "Matter A",
    };
    expect(recordRecentSearch("query", mismatchedScope, storage)).toEqual([]);
    expect(recordRecentFile(file, mismatchedScope, storage)).toEqual([]);
    expect(readRecentSearches(mismatchedScope, storage)).toEqual([]);
    expect(readRecentFiles(mismatchedScope, storage)).toEqual([]);
    expect(storage.length).toBe(0);
  });
});
