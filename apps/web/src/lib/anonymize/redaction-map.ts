import { openDB } from "idb";
import type { DBSchema, IDBPDatabase } from "idb";

import type { OperatorType } from "./types";

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
export type PersistedRedactionMap = {
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

/**
 * Load a redaction map from IndexedDB by document ID.
 * Returns null if no map exists for the given ID.
 */
export const loadRedactionMap = async (
  documentId: string,
): Promise<PersistedRedactionMap | null> => {
  const db = await getDb();
  const record = await db.get(STORE_NAME, documentId);
  return record ?? null;
};

/**
 * Delete a redaction map from IndexedDB.
 */
export const deleteRedactionMap = async (documentId: string): Promise<void> => {
  const db = await getDb();
  await db.delete(STORE_NAME, documentId);
};

/**
 * List all persisted redaction maps, ordered by creation
 * date (newest first).
 */
export const listRedactionMaps = async (): Promise<PersistedRedactionMap[]> => {
  const db = await getDb();
  const all = await db.getAll(STORE_NAME);
  return all.toSorted(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
};

/**
 * Rebuild a Map<string, string> from a persisted record.
 * This is the format expected by `deanonymise()` in
 * `redact.ts`.
 */
export const toRedactionMap = (
  record: PersistedRedactionMap,
): Map<string, string> => {
  const map = new Map<string, string>();
  for (const entry of record.entries) {
    map.set(entry.placeholder, entry.original);
  }
  return map;
};

/**
 * Resolve placeholders in AI-generated text back to
 * original values using a persisted redaction map.
 *
 * This is the primary consumer of the persistence layer:
 * when an AI responds with "[PERSON_1] is the buyer",
 * this function replaces it with "Pavel Novák is the buyer".
 */
export const resolveAiText = (
  text: string,
  record: PersistedRedactionMap,
): string => {
  // Sort by placeholder length descending so "[PERSON_10]"
  // is replaced before "[PERSON_1]" (substring safety).
  const sorted = record.entries.toSorted(
    (a, b) => b.placeholder.length - a.placeholder.length,
  );
  let result = text;
  for (const entry of sorted) {
    result = result.replaceAll(entry.placeholder, entry.original);
  }
  return result;
};

/**
 * Replace real values in user text with placeholders
 * before sending to AI. The inverse of resolveAiText.
 *
 * Useful for follow-up queries where the user types
 * real names but the AI context uses placeholders.
 */
export const anonymiseForAi = (
  text: string,
  record: PersistedRedactionMap,
): string => {
  // Sort by original length descending so "Jan Novák" is
  // replaced before "Jan" (prevents substring corruption).
  const sorted = record.entries.toSorted(
    (a, b) => b.original.length - a.original.length,
  );
  let result = text;
  for (const entry of sorted) {
    result = result.replaceAll(entry.original, entry.placeholder);
  }
  return result;
};
