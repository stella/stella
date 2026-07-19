import type { AnonymizationTerm } from "@stll/folio-react";

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

type TrailingSingleFlightOptions = {
  run: () => Promise<void>;
  onError?: (error: unknown) => void;
};

/**
 * Single-flight coordinator with a coalesced trailing run.
 *
 * The three checkpoint paths (debounced autosave, awaitable flush,
 * and the Cmd/Ctrl+S handler) each snapshot the live editor and
 * persist the result. Firing two concurrently races two `save()`
 * round-trips whose `setAutosaveStatus` writes land in
 * nondeterministic order, so a stale "pending"/"synced" can win.
 *
 * The returned `trigger` runs `run` immediately when idle. Triggers
 * that arrive while a run is in flight coalesce into exactly one
 * trailing run that fires after the in-flight run settles, no matter
 * how many arrived. Because `run` re-snapshots the editor when it
 * executes, the trailing run captures state produced during the
 * in-flight save (latest wins) and nothing is dropped.
 *
 * `trigger` resolves once a run that started at or after the call
 * has settled, so awaitable callers (flush before navigation) block
 * on a save that reflects their snapshot. A trigger during an
 * in-flight run is satisfied by the trailing run, never by the
 * already-snapshotted in-flight run.
 *
 * Rejections are routed to `onError` and never abort the trailing
 * run, leave a caller's promise unsettled, or surface as an
 * unhandled rejection; `onError` fires exactly once per failed run.
 */
export const createTrailingSingleFlight = ({
  run,
  onError,
}: TrailingSingleFlightOptions): (() => Promise<void>) => {
  let active = false;
  let queued = false;
  // Resolvers waiting for the *next* run to settle. A trigger is
  // satisfied only by a run that starts at or after it, since an
  // in-flight run may have snapshotted before the trigger fired.
  let nextRunSettlers: (() => void)[] = [];

  const drain = async () => {
    active = true;
    try {
      do {
        queued = false;
        const settlers = nextRunSettlers;
        nextRunSettlers = [];
        try {
          // Sequential by design: the trailing run must not start
          // until the in-flight run settles (single-flight).
          // eslint-disable-next-line no-await-in-loop
          await run();
        } catch (error) {
          try {
            onError?.(error);
          } catch {
            // A reporter failure must not prevent settler resolution or
            // abort a queued trailing run below: onError is telemetry,
            // not part of the save contract.
          }
        }
        for (const settle of settlers) {
          settle();
        }
        // The returned trigger below can set `queued = true` while `run()`
        // above is in flight; the checker only sees the straight-line reset
        // on the line above and misses that concurrent path.
        // eslint-disable-next-line typescript/no-unnecessary-condition
      } while (queued);
    } finally {
      active = false;
    }
  };

  // Returns the already-created `settled` promise synchronously (either
  // immediately, or after firing `drain` without awaiting it); wrapping in
  // `async` would add a redundant microtask and could let a trigger observe
  // a settled promise before `drain` has synchronously registered it as
  // active.
  // eslint-disable-next-line typescript/promise-function-async
  return () => {
    const settled = new Promise<void>((resolve) => {
      // Runs synchronously: the resolver is registered before the
      // active/idle branch below reads or mutates coordinator state.
      nextRunSettlers.push(resolve);
    });
    if (active) {
      queued = true;
      return settled;
    }
    void drain();
    return settled;
  };
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
