import type { AnonymizationTerm } from "@stll/folio";

export type AutosaveStatus = "synced" | "pending" | "syncing";

type ResolveCheckpointAutosaveStatusOptions = {
  buffer: ArrayBuffer | null;
  checkpointSaved: boolean;
};

/**
 * Shared decision for the three near-duplicate checkpoint paths
 * (debounced autosave, awaitable flush, and the Cmd/Ctrl+S
 * handler). All three serialize the live editor, then persist the
 * resulting buffer: a missing buffer or a failed round-trip leaves
 * the session "pending"; a successful round-trip is "synced".
 *
 * The `null` buffer case mirrors `ref.save()` returning nothing
 * (nothing to persist), so callers pass `null` rather than
 * branching on it themselves.
 */
export const resolveCheckpointAutosaveStatus = ({
  buffer,
  checkpointSaved,
}: ResolveCheckpointAutosaveStatusOptions): AutosaveStatus => {
  if (buffer === null) {
    return "pending";
  }

  return checkpointSaved ? "synced" : "pending";
};

type BuildAnonymizationDetectionKeyOptions = {
  text: string;
  excludedCanonicals: Iterable<string>;
};

/**
 * Cache key for the detection heartbeat. Exclusions are part of
 * the key because marking an entity as a false positive must rerun
 * detection against the same text with the new allowlist. Accepts
 * any iterable (set or already-deduped array) and sorts it so the
 * key is stable regardless of order.
 */
export const buildAnonymizationDetectionKey = ({
  text,
  excludedCanonicals,
}: BuildAnonymizationDetectionKeyOptions): string =>
  `${[...excludedCanonicals].sort().join("|")}~${text}`;

type DecideAnonymizationDetectionRunOptions = {
  text: string;
  cacheKey: string;
  lastDeliveredKey: string | null;
  inFlightUntil: number;
  now: number;
};

export type AnonymizationDetectionDecision =
  | { action: "skip" }
  | { action: "markRan" }
  | { action: "alreadyDelivered" }
  | { action: "run" };

/**
 * Decides what the detection heartbeat should do for the current
 * doc text and allowlist:
 * - `skip`: a request is still in flight, do nothing.
 * - `markRan`: empty doc, release the placeholder without running.
 * - `alreadyDelivered`: results for this exact key already landed.
 * - `run`: dispatch a fresh worker request.
 */
export const decideAnonymizationDetectionRun = ({
  text,
  cacheKey,
  lastDeliveredKey,
  inFlightUntil,
  now,
}: DecideAnonymizationDetectionRunOptions): AnonymizationDetectionDecision => {
  if (now < inFlightUntil) {
    return { action: "skip" };
  }

  if (text.length === 0) {
    return { action: "markRan" };
  }

  if (cacheKey === lastDeliveredKey) {
    return { action: "alreadyDelivered" };
  }

  return { action: "run" };
};

type DetectionPair = {
  original: string;
  label: string;
};

/**
 * Collapses worker-detected pairs into a deduplicated term list.
 * Two pairs collide when they share a label and a
 * case-insensitive original surface form; the first occurrence
 * wins and keeps its original casing.
 */
export const dedupeDetectedAnonymizationTerms = (
  pairs: readonly DetectionPair[],
): AnonymizationTerm[] => {
  const byCanonical = new Map<string, AnonymizationTerm>();
  for (const pair of pairs) {
    const key = `${pair.label} ${pair.original.toLowerCase()}`;
    if (!byCanonical.has(key)) {
      byCanonical.set(key, {
        canonical: pair.original,
        label: pair.label,
      });
    }
  }
  return [...byCanonical.values()];
};

type AllowlistEntry = {
  canonical: string;
};

/**
 * Per-doc allowlist of canonicals flagged as false positives,
 * lowercased so membership checks are case-insensitive against
 * both worker output and catalog terms.
 */
export const buildExcludedCanonicalsSet = (
  entries: readonly AllowlistEntry[],
): Set<string> => {
  const set = new Set<string>();
  for (const entry of entries) {
    set.add(entry.canonical.toLowerCase());
  }
  return set;
};

type MergeAnonymizationTermsOptions = {
  isAnonymizationActive: boolean;
  workspaceTerms: readonly AnonymizationTerm[];
  detectedTerms: readonly AnonymizationTerm[];
  excludedCanonicals: ReadonlySet<string>;
};

/**
 * The live term list dispatched into the Folio decoration plugin:
 * catalog vocabulary minus allowlisted canonicals, plus
 * worker-detected entities. Empty while the facet is off-screen.
 *
 * Catalog terms go straight to Folio without passing through the
 * worker, so they must be filtered here; worker-detected terms are
 * already allowlist-filtered upstream.
 */
export const mergeAnonymizationTerms = ({
  isAnonymizationActive,
  workspaceTerms,
  detectedTerms,
  excludedCanonicals,
}: MergeAnonymizationTermsOptions): AnonymizationTerm[] => {
  if (!isAnonymizationActive) {
    return [];
  }

  const filteredWorkspace =
    excludedCanonicals.size === 0
      ? workspaceTerms
      : workspaceTerms.filter(
          (term) => !excludedCanonicals.has(term.canonical.toLowerCase()),
        );
  return [...filteredWorkspace, ...detectedTerms];
};

type AnonymizationMatch = {
  canonical: string;
  label: string;
};

export type AggregatedAnonymizationMatches = {
  totalMatches: number;
  countByCanonical: Map<string, number>;
  labelByCanonical: Map<string, string>;
};

/**
 * Folds the plugin's live match list into the per-canonical counts
 * and labels the inspector facet publishes. The first label seen
 * for a canonical wins.
 */
export const aggregateAnonymizationMatches = (
  matches: readonly AnonymizationMatch[],
): AggregatedAnonymizationMatches => {
  const countByCanonical = new Map<string, number>();
  const labelByCanonical = new Map<string, string>();
  for (const match of matches) {
    countByCanonical.set(
      match.canonical,
      (countByCanonical.get(match.canonical) ?? 0) + 1,
    );
    if (!labelByCanonical.has(match.canonical)) {
      labelByCanonical.set(match.canonical, match.label);
    }
  }
  return {
    totalMatches: matches.length,
    countByCanonical,
    labelByCanonical,
  };
};
