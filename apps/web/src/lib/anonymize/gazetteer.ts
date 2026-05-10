// TODO: FIXME — idb's DBSchema resolves as error type, cascading unsafe-* errors
import { openDB } from "idb";
import type { DBSchema, IDBPDatabase } from "idb";

import type { GazetteerEntry } from "@stll/anonymize-wasm";

const DB_NAME = "stella-gazetteer";
const DB_VERSION = 1;
const STORE_NAME = "entries";

type GazetteerDB = DBSchema & {
  entries: {
    key: string;
    value: GazetteerEntry;
    indexes: {
      "by-workspace": string;
    };
  };
};

let dbPromise: Promise<IDBPDatabase<GazetteerDB>> | null = null;

// eslint-disable-next-line @typescript-eslint/promise-function-async -- lazy init, not always async
const getDb = (): Promise<IDBPDatabase<GazetteerDB>> => {
  // oxlint-disable-next-line typescript-eslint/prefer-nullish-coalescing
  if (!dbPromise) {
    dbPromise = openDB<GazetteerDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: "id",
        });
        store.createIndex("by-workspace", "workspaceId");
      },
    }).catch((error: unknown) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
};

/**
 * Retrieve all gazetteer entries for a workspace.
 */
export const getEntries = async (
  workspaceId: string,
): Promise<GazetteerEntry[]> => {
  const db = await getDb();
  return db.getAllFromIndex(STORE_NAME, "by-workspace", workspaceId);
};

/**
 * Add or update a gazetteer entry.
 */
export const putEntry = async (entry: GazetteerEntry): Promise<void> => {
  const db = await getDb();
  await db.put(STORE_NAME, entry);
};
