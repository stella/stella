import { describe, expect, test } from "bun:test";

import {
  createGrantStore,
  grantStorageKey,
  type KeyValueStorage,
  type StoredGrant,
} from "@/lib/oauth/grant-store";

const memoryStorage = (): KeyValueStorage & { values: Map<string, string> } => {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
    values,
  };
};

const grant: StoredGrant = {
  clientId:
    "https://api.example.test/v1/mcp/oauth/outlook-client-metadata.json",
  issuer: "https://api.example.test/api/auth",
  refreshToken: "refresh-1",
  resource: "https://api.example.test/v1",
  revocationEndpoint: "https://api.example.test/api/auth/oauth2/revoke",
  tokenEndpoint: "https://api.example.test/api/auth/oauth2/token",
};

describe("grant store", () => {
  test("keeps the grant under the mailbox partition", () => {
    const storage = memoryStorage();
    const store = createGrantStore({ partitionKey: "mailbox-1", storage });

    store.write(grant);

    expect(store.read()).toEqual(grant);
    expect([...storage.values.keys()]).toEqual([grantStorageKey("mailbox-1")]);
    expect(
      createGrantStore({ partitionKey: undefined, storage }).read(),
    ).toBeNull();
  });

  test("forgets the grant", () => {
    const store = createGrantStore({
      partitionKey: undefined,
      storage: memoryStorage(),
    });
    store.write(grant);
    store.clear();

    expect(store.read()).toBeNull();
  });

  test("ignores a damaged or foreign value", () => {
    const storage = memoryStorage();
    const store = createGrantStore({ partitionKey: undefined, storage });

    storage.setItem(grantStorageKey(undefined), "{not json");
    expect(store.read()).toBeNull();

    storage.setItem(
      grantStorageKey(undefined),
      JSON.stringify({ ...grant, refreshToken: "" }),
    );
    expect(store.read()).toBeNull();
  });

  test("works without storage", () => {
    const store = createGrantStore({ partitionKey: undefined, storage: null });
    store.write(grant);

    expect(store.read()).toBeNull();
  });
});
