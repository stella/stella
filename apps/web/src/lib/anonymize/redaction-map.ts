import { openDB } from "idb";
import type { DBSchema, IDBPDatabase } from "idb";

import type { OperatorType } from "@stll/anonymize-wasm";

const DB_NAME = "stella-redaction-maps";
const DB_VERSION = 1;
const STORE_NAME = "maps";

/**
 * A single entry in the persisted redaction map.
 * Tracks the placeholder, original text, and which
 * operator produced the redaction.
 */
type RedactionEntry = {
  placeholder: string;
  original: string;
  operator: OperatorType;
};

/**
 * A persisted redaction map record, keyed by document ID.
 * Stored in IndexedDB so AI response resolution survives
 * page reloads and tab switches.
 */
type PersistedRedactionMap = {
  /** Unique identifier for the anonymised document. */
  documentId: string;
  /** Human-readable label (filename, matter reference). */
  label: string;
  /** Redaction entries: placeholder → original mapping. */
  entries: RedactionEntry[];
  /** ISO timestamp of when the map was created. */
  createdAt: string;
};

type RedactionMapDB = DBSchema & {
  maps: {
    key: string;
    value: PersistedRedactionMap;
  };
};

let dbPromise: Promise<IDBPDatabase<RedactionMapDB>> | null = null;

// eslint-disable-next-line @typescript-eslint/promise-function-async -- lazy init pattern
const getDb = (): Promise<IDBPDatabase<RedactionMapDB>> => {
  dbPromise ??= openDB<RedactionMapDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      db.createObjectStore(STORE_NAME, {
        keyPath: "documentId",
      });
    },
  }).catch((error: unknown) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
};

/**
 * Persist a redaction map to IndexedDB. Overwrites any
 * existing map for the same documentId.
 */
export const saveRedactionMap = async (
  documentId: string,
  label: string,
  redactionMap: Map<string, string>,
  operatorMap: Map<string, OperatorType>,
): Promise<void> => {
  const entries: RedactionEntry[] = [];

  for (const [placeholder, original] of redactionMap) {
    entries.push({
      placeholder,
      original,
      operator: operatorMap.get(placeholder) ?? "replace",
    });
  }

  const record: PersistedRedactionMap = {
    documentId,
    label,
    entries,
    createdAt: new Date().toISOString(),
  };

  const db = await getDb();
  await db.put(STORE_NAME, record);
};
