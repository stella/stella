// TODO: FIXME — idb's DBSchema resolves as error type, cascading unsafe-* errors
import { AhoCorasick } from "@monyone/aho-corasick";
import { openDB } from "idb";
import type { DBSchema, IDBPDatabase } from "idb";

import { levenshtein } from "./levenshtein";
import { DETECTION_SOURCES } from "./types";
import type { Entity, GazetteerEntry } from "./types";

const DB_NAME = "stella-gazetteer";
const DB_VERSION = 1;
const STORE_NAME = "entries";
const MAX_EDIT_DISTANCE = 2;
const MAX_PREFIX_OVERSHOOT = 6;

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

/**
 * Remove a gazetteer entry by ID.
 */
export const deleteEntry = async (id: string): Promise<void> => {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment
  const db = await getDb();
  // oxlint-disable-next-line typescript-eslint/no-unsafe-call, typescript-eslint/no-unsafe-member-access
  await db.delete(STORE_NAME, id);
};

/**
 * Collect all searchable strings (canonical + variants)
 * from gazetteer entries, mapped to their labels.
 */
const buildSearchTerms = (entries: GazetteerEntry[]): Map<string, string> => {
  const terms = new Map<string, string>();
  for (const entry of entries) {
    terms.set(entry.canonical, entry.label);
    for (const variant of entry.variants) {
      terms.set(variant, entry.label);
    }
  }
  return terms;
};

/**
 * Exact-match scan using Aho-Corasick automaton.
 * Single O(n) pass through the full text.
 */
export const scanExact = (
  fullText: string,
  entries: GazetteerEntry[],
): Entity[] => {
  const terms = buildSearchTerms(entries);
  const patterns = [...terms.keys()];

  if (patterns.length === 0) {
    return [];
  }

  // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment, typescript-eslint/no-unsafe-call
  const ac = new AhoCorasick(patterns);
  const results: Entity[] = [];

  // oxlint-disable-next-line typescript-eslint/no-unsafe-call, typescript-eslint/no-unsafe-member-access
  for (const match of ac.matchInText(fullText)) {
    // oxlint-disable-next-line typescript-eslint/no-unsafe-argument, typescript-eslint/no-unsafe-member-access
    const label = terms.get(match.keyword);
    if (!label) {
      continue;
    }

    results.push({
      // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment, typescript-eslint/no-unsafe-member-access
      start: match.begin,
      // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment, typescript-eslint/no-unsafe-member-access
      end: match.end,
      label,
      // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment, typescript-eslint/no-unsafe-member-access
      text: match.keyword,
      score: 1,
      source: DETECTION_SOURCES.GAZETTEER,
    });
  }

  return results;
};

/**
 * Fuzzy scan: find approximate matches for gazetteer
 * terms in the text. Catches missing diacritics
 * ("Muller" vs "Müller") and short typos.
 *
 * Uses a sliding window with Levenshtein distance <= 2.
 * Only runs on terms >= 4 chars (short terms produce
 * too many false positives with fuzzy matching).
 *
 * Also checks prefix matches for legal suffix variants
 * ("Česká spořitelna a.s." vs "Česká spořitelna").
 */
const MAX_FUZZY_TEXT_LENGTH = 20_000;

export const scanFuzzy = (
  fullText: string,
  entries: GazetteerEntry[],
  exactSpans: Entity[],
): Entity[] => {
  if (fullText.length > MAX_FUZZY_TEXT_LENGTH) {
    return [];
  }

  const terms = buildSearchTerms(entries);
  const results: Entity[] = [];

  const isOverlapping = (start: number, end: number): boolean =>
    exactSpans.some((e) => start < e.end && end > e.start);

  for (const [term, label] of terms) {
    if (term.length < 4) {
      continue;
    }

    const windowSize = term.length;
    const maxWindow = windowSize + MAX_PREFIX_OVERSHOOT;

    for (let i = 0; i <= fullText.length - windowSize; i++) {
      // Check Levenshtein on same-length window
      const candidate = fullText.slice(i, i + windowSize);
      const dist = levenshtein(term.toLowerCase(), candidate.toLowerCase());

      if (dist > MAX_EDIT_DISTANCE) {
        continue;
      }

      // Exact match: try prefix extension for legal entity
      // suffixes like "a.s.", "GmbH", "s.r.o."
      if (dist === 0 && i + maxWindow <= fullText.length) {
        const extended = fullText.slice(i, i + maxWindow);
        const nextSpace = extended.indexOf(" ", windowSize);
        if (nextSpace > windowSize) {
          const prefixed = extended.slice(0, nextSpace);
          if (!isOverlapping(i, i + prefixed.length)) {
            results.push({
              start: i,
              end: i + prefixed.length,
              label,
              text: prefixed,
              score: 0.9,
              source: DETECTION_SOURCES.GAZETTEER,
            });
            continue;
          }
        }
      }

      // Skip positions already covered by exact matches
      if (isOverlapping(i, i + windowSize)) {
        continue;
      }

      // Fuzzy match (dist 1-2) or case-variant exact match
      // (dist === 0 on lowercase but surface form differs,
      // meaning the prefix extension above didn't fire)
      if (dist > 0 || candidate !== term) {
        results.push({
          start: i,
          end: i + windowSize,
          label,
          text: candidate,
          score: 0.85,
          source: DETECTION_SOURCES.GAZETTEER,
        });
      }
    }
  }

  return results;
};
