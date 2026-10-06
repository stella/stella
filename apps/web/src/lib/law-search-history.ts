import { useSyncExternalStore } from "react";

import { Result } from "better-result";
import * as v from "valibot";
import { createStore } from "zustand/vanilla";

import { parseCaseLawDecisionPath } from "@stll/api-contract/case-law-decision-route";
import { parseStatutePath } from "@stll/api-contract/statute-route";
import { Temporal } from "@stll/time";

import {
  onStorageOwnerChange,
  userStorageKey,
} from "@/lib/account/user-scoped-storage";
import { readStoredJson, writeStoredJson } from "@/lib/stored-json";

// Keep the key so existing owner-scoped searches migrate without a second store.
const STORAGE_KEY = "law_search_history";
const RECENT_LIMIT_PER_KIND = 50;
const atSchema = v.pipe(
  v.string(),
  v.check((at) => Result.try(() => Temporal.Instant.from(at)).isOk()),
);
const openedFields = {
  id: v.pipe(v.string(), v.nonEmpty()),
  title: v.pipe(v.string(), v.nonEmpty()),
  // Stored links may only reopen public law pages, never arbitrary URLs.
  path: v.pipe(
    v.string(),
    v.startsWith("/law/"),
    v.regex(/^\/law\/[A-Za-z0-9_/-]+$/u),
    v.check(
      (path) =>
        parseCaseLawDecisionPath(path) !== null ||
        parseStatutePath(path) !== null,
    ),
  ),
  at: atSchema,
};
const legacyEntrySchema = v.object({
  query: v.pipe(v.string(), v.trim(), v.nonEmpty()),
  at: atSchema,
});
const recentEntrySchema = v.variant("kind", [
  v.object({ kind: v.literal("search"), ...legacyEntrySchema.entries }),
  v.object({ kind: v.literal("decision"), ...openedFields }),
  v.object({ kind: v.literal("statute"), ...openedFields }),
]);

export type LawRecentEntry = v.InferOutput<typeof recentEntrySchema>;
export type LawRecentFilter = "all" | LawRecentEntry["kind"];
const EMPTY: readonly LawRecentEntry[] = [];

export const lawRecentKey = (entry: LawRecentEntry): string =>
  entry.kind === "search"
    ? `${entry.kind}:${entry.query}`
    : `${entry.kind}:${entry.id}`;

export const filterLawRecent = (
  entries: readonly LawRecentEntry[],
  filter: LawRecentFilter,
): readonly LawRecentEntry[] =>
  filter === "all" ? entries : entries.filter((entry) => entry.kind === filter);

const normalizeRecent = (
  entries: readonly LawRecentEntry[],
): readonly LawRecentEntry[] => {
  const seen = new Set<string>();
  const counts = new Map<LawRecentEntry["kind"], number>();
  return entries
    .toSorted((a, b) => Temporal.Instant.compare(b.at, a.at))
    .filter((entry) => {
      const key = lawRecentKey(entry);
      if (
        seen.has(key) ||
        (counts.get(entry.kind) ?? 0) >= RECENT_LIMIT_PER_KIND
      ) {
        return false;
      }
      seen.add(key);
      counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
      return true;
    });
};

/** Bad rows are dropped individually; old searches become recent search rows. */
export const readLawRecent = (
  raw: string | null,
): readonly LawRecentEntry[] => {
  const rows = readStoredJson(raw, v.array(v.unknown()));
  if (rows === null) {
    return EMPTY;
  }
  const entries: LawRecentEntry[] = [];
  for (const row of rows) {
    const recent = v.safeParse(recentEntrySchema, row);
    if (recent.success) {
      entries.push(recent.output);
      continue;
    }
    // Only rows without a discriminator belong to the old search format.
    if (typeof row !== "object" || row === null || "kind" in row) {
      continue;
    }
    const legacy = v.safeParse(legacyEntrySchema, row);
    if (legacy.success) {
      entries.push({ kind: "search", ...legacy.output });
    }
  }
  return normalizeRecent(entries);
};

type RecentState = { entries: readonly LawRecentEntry[]; hydrated: boolean };
const recentStore = createStore<RecentState>(() => ({
  entries: EMPTY,
  hydrated: false,
}));

const hydrate = (): void => {
  if (recentStore.getState().hydrated) {
    return;
  }
  const raw = Result.try(() =>
    localStorage.getItem(userStorageKey(STORAGE_KEY)),
  ).unwrapOr(null);
  recentStore.setState({ entries: readLawRecent(raw), hydrated: true });
};
const save = (entries: readonly LawRecentEntry[]): void => {
  const storage = Result.try(() => localStorage).unwrapOr(null);
  if (storage !== null) {
    writeStoredJson(storage, userStorageKey(STORAGE_KEY), entries);
  }
  recentStore.setState({ entries });
};
const record = (entry: LawRecentEntry): void => {
  hydrate();
  save(
    normalizeRecent([
      entry,
      ...recentStore
        .getState()
        .entries.filter(
          (previous) => lawRecentKey(previous) !== lawRecentKey(entry),
        ),
    ]),
  );
};
const now = () =>
  Temporal.Now.instant().toString({ fractionalSecondDigits: 3 });

export const recordLawSearch = (query: string): void => {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return;
  }
  record({ kind: "search", query: trimmed, at: now() });
};
type OpenedLawEntry = Omit<
  Extract<LawRecentEntry, { kind: "decision" | "statute" }>,
  "at"
>;
export const recordLawOpen = (entry: OpenedLawEntry): void =>
  record({ ...entry, at: now() });

export const removeLawRecent = (entry: LawRecentEntry): void => {
  hydrate();
  save(
    recentStore
      .getState()
      .entries.filter(
        (previous) => lawRecentKey(previous) !== lawRecentKey(entry),
      ),
  );
};
export const clearLawRecent = (): void => {
  hydrate();
  save(EMPTY);
};

onStorageOwnerChange(() => {
  if (!recentStore.getState().hydrated) {
    return;
  }
  recentStore.setState({ entries: EMPTY, hydrated: false });
  hydrate();
});
const subscribe = (onChange: () => void) => {
  const unsubscribe = recentStore.subscribe(onChange);
  hydrate();
  return unsubscribe;
};
const getSnapshot = () => recentStore.getState().entries;
const getServerSnapshot = () => EMPTY;

/** Browser-local activity, reset on owner change; never shared or sent to analytics. */
export const useLawRecent = (): readonly LawRecentEntry[] =>
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
