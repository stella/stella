import type { GazetteerEntry } from "@stll/anonymize";
// TODO: FIXME — idb's DBSchema resolves as error type, cascading unsafe-* errors
import { openDB } from "idb";
import type { DBSchema, IDBPDatabase } from "idb";

const DB_NAME = "stella-gazetteer";
const DB_VERSION = 1;
const STORE_NAME = "entries";

// oxlint-disable-next-line typescript-eslint/no-redundant-type-constituents
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
    // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment, typescript-eslint/no-unsafe-call
    dbPromise = openDB<GazetteerDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment, typescript-eslint/no-unsafe-call, typescript-eslint/no-unsafe-member-access
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: "id",
        });
        // oxlint-disable-next-line typescript-eslint/no-unsafe-call, typescript-eslint/no-unsafe-member-access
        store.createIndex("by-workspace", "workspaceId");
      },
      // oxlint-disable-next-line typescript-eslint/no-unsafe-member-access
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
  // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment
  const db = await getDb();
  // oxlint-disable-next-line typescript-eslint/no-unsafe-return, typescript-eslint/no-unsafe-call, typescript-eslint/no-unsafe-member-access
  return db.getAllFromIndex(STORE_NAME, "by-workspace", workspaceId);
};

/**
 * Add or update a gazetteer entry.
 */
export const putEntry = async (entry: GazetteerEntry): Promise<void> => {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment
  const db = await getDb();
  // oxlint-disable-next-line typescript-eslint/no-unsafe-call, typescript-eslint/no-unsafe-member-access
  await db.put(STORE_NAME, entry);
};
