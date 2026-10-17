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

const storage = new MemoryStorage();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: storage,
});

let scope: SearchRecentsScope = {
  owner: storageOwner(),
  organizationId: "org-1",
  userId: "user-1",
};

beforeEach(() => {
  storage.clear();
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
    recordRecentSearch(" černý ", scope);
    recordRecentSearch("agreement", scope);
    recordRecentSearch("černý", scope);

    expect(readRecentSearches(scope).map((item) => item.query)).toEqual([
      "černý",
      "agreement",
    ]);
  });

  test("caps recent searches", () => {
    for (const query of ["a", "b", "c", "d", "e", "f", "g"]) {
      recordRecentSearch(query, scope);
    }

    expect(readRecentSearches(scope).map((item) => item.query)).toEqual([
      "g",
      "f",
      "e",
      "d",
      "c",
      "b",
    ]);
  });

  test("records recent files newest first and dedupes by entity", () => {
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
    );

    expect(
      readRecentFiles(scope).map((item) => ({
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
    storage.setItem(
      userStorageKey("stella-search-recent-files:org-1:", {
        kind: "user",
        userId: "user-1",
      }),
      JSON.stringify({
        version: 1,
        value: [
          {
            entityId: "entity-1",
            openedAt: new Date().toISOString(),
            title: "Legacy.pdf",
            workspaceId: "workspace-1",
            workspaceName: "Matter A",
          },
        ],
      }),
    );

    expect(readRecentFiles(scope).map((item) => item.title)).toEqual([
      "Legacy.pdf",
    ]);
  });

  test("drops recent file records with empty identity fields", () => {
    storage.setItem(
      userStorageKey("stella-search-recent-files:org-1:", {
        kind: "user",
        userId: "user-1",
      }),
      JSON.stringify({
        version: 1,
        value: [
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
        ],
      }),
    );

    expect(readRecentFiles(scope)).toEqual([]);
  });

  test("does not overwrite recents with empty file identity fields", () => {
    const validFile = {
      entityId: "entity-1",
      title: "Existing.pdf",
      workspaceId: "workspace-1",
      workspaceName: "Matter A",
    };
    recordRecentFile(validFile, scope);
    const existing = readRecentFiles(scope);

    expect(recordRecentFile({ ...validFile, entityId: "" }, scope)).toEqual(
      existing,
    );
    expect(recordRecentFile({ ...validFile, workspaceId: "" }, scope)).toEqual(
      existing,
    );
    expect(readRecentFiles(scope)).toEqual(existing);
  });

  test("drops ill-formed resource identities at the storage boundary", () => {
    const illFormedId = "\uD800";
    storage.setItem(
      userStorageKey("stella-search-recent-files:org-1:", {
        kind: "user",
        userId: "user-1",
      }),
      JSON.stringify({
        version: 1,
        value: [
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
        ],
      }),
    );
    expect(readRecentFiles(scope)).toEqual([]);

    const validFile = {
      entityId: "entity-1",
      title: "Existing.pdf",
      workspaceId: "workspace-1",
      workspaceName: "Matter A",
    };
    recordRecentFile(validFile, scope);
    const existing = readRecentFiles(scope);
    expect(
      recordRecentFile({ ...validFile, entityId: illFormedId }, scope),
    ).toEqual(existing);
    expect(
      recordRecentFile({ ...validFile, workspaceId: illFormedId }, scope),
    ).toEqual(existing);
  });

  test("scopes recents by organization and user", () => {
    const otherScope: SearchRecentsScope = {
      owner: scope.owner,
      organizationId: "org-2",
      userId: "user-1",
    };

    recordRecentSearch("privileged matter", scope);

    expect(readRecentSearches(otherScope)).toEqual([]);
    expect(readRecentSearches(scope).map((item) => item.query)).toEqual([
      "privileged matter",
    ]);
  });

  test("ignores corrupted storage payloads", () => {
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
      JSON.stringify({ version: 1, value: [{ bad: true }] }),
    );

    expect(readRecentSearches(scope)).toEqual([]);
    expect(readRecentFiles(scope)).toEqual([]);
  });
  test("captured recents follow the current owner across visitor, another user and return transitions", () => {
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
      recordRecentSearch("account A", scope);
      recordRecentFile(file, scope);
      expect(readRecentSearches(scope).map((item) => item.query)).toEqual([
        "account A",
      ]);
      expect(readRecentFiles(scope).map((item) => item.title)).toEqual([
        "Draft.pdf",
      ]);

      for (const nextUserId of [null, "user-2", "user-1"]) {
        if (nextUserId === null) {
          releaseUserStorage(areas);
        } else {
          queryClient.setQueryData(["session"], { user: { id: nextUserId } });
        }
        expect(readRecentSearches(scope)).toEqual([]);
        expect(readRecentFiles(scope)).toEqual([]);
        expect(recordRecentSearch("delayed account A", scope)).toEqual([]);
        expect(recordRecentFile(file, scope)).toEqual([]);
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
        recordRecentSearch("fresh account A", refreshedScope).map(
          (item) => item.query,
        ),
      ).toEqual(["fresh account A", "account A"]);
      expect(
        recordRecentFile(file, refreshedScope).map((item) => item.title),
      ).toEqual(["Draft.pdf"]);
    } finally {
      unsubscribe();
    }
  });

  test("an outdated owner scope does not read retained entries", () => {
    recordRecentSearch("account A", scope);
    recordRecentFile(
      {
        entityId: "entity-1",
        title: "Draft.pdf",
        workspaceId: "workspace-1",
        workspaceName: "Matter A",
      },
      scope,
    );
    const queryClient = new QueryClient();
    const unsubscribe = installUserScopedStorage(queryClient, () => ({
      local: null,
      session: null,
    }));
    queryClient.setQueryData(["session"], { user: { id: "user-2" } });
    unsubscribe();
    expect(storage.length).toBe(2);
    expect(readRecentSearches(scope)).toEqual([]);
    expect(readRecentFiles(scope)).toEqual([]);
  });

  test("an auth scope that differs from the current storage owner cannot read or write recents", () => {
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
    expect(recordRecentSearch("query", mismatchedScope)).toEqual([]);
    expect(recordRecentFile(file, mismatchedScope)).toEqual([]);
    expect(readRecentSearches(mismatchedScope)).toEqual([]);
    expect(readRecentFiles(mismatchedScope)).toEqual([]);
    expect(storage.length).toBe(0);
  });
});

test.each([
  { kind: "statute", number: "172", year: "2026" },
  { kind: "decision", courtAbbreviation: "ÚS", courtTier: "constitutional" },
  { kind: "decision", courtAbbreviation: null },
] as const)(
  "recents retain resolved document identity through storage: %j",
  (documentIdentity) => {
    recordRecentFile(
      {
        entityId: "file_identity",
        workspaceId: "matter_identity",
        workspaceName: "Civil proceeding",
        title: "Legal instrument",
        documentIdentity,
      },
      scope,
    );
    expect(readRecentFiles(scope).at(0)?.documentIdentity).toEqual(
      documentIdentity,
    );
  },
);
