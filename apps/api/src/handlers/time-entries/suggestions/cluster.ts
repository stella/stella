import type { TimeEntrySuggestionEvidence } from "@stll/api-contract/time-entry-types";
import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

/**
 * One observed action by the timekeeper inside a matter. `key` is unique per
 * signal and orders ties, so clustering is deterministic for equal instants.
 */
export type ActivitySignal = {
  at: Date;
  key: string;
  identity: {
    source: "chat_message" | "audit_log";
    resourceId: string;
    timestamp: string;
  };
  evidence:
    | { type: "chat_thread"; id: string; title: string }
    | {
        type: "resource";
        id: string;
        resourceType: string;
        name: string | null;
        action: string;
      };
};

export type SuggestionCluster = {
  fingerprint: string;
  startedAt: Date;
  endedAt: Date;
  durationMinutes: number;
  signalCount: number;
  evidence: TimeEntrySuggestionEvidence[];
};

type ClusterActivitySignalsOptions = {
  /** ISO date (YYYY-MM-DD) the signals were bucketed into. */
  date: string;
  signals: readonly ActivitySignal[];
  mergeGapMinutes: number;
  tailMinutes: number;
};

const MS_PER_MINUTE = 60_000;

/**
 * Identity of a cluster for its day. Only the earliest signal takes part, so a
 * cluster keeps its fingerprint while later signals extend it. Decisions use
 * that identity for idempotent writes, while their evidence owns the exact
 * signals they cover. Two clusters that merge keep the earlier identity.
 */
export const suggestionFingerprint = (date: string, firstKey: string) =>
  hashSha256Hex(`${date}\n${firstKey}`);

const compareSignals = (a: ActivitySignal, b: ActivitySignal) => {
  const byTime = a.at.getTime() - b.at.getTime();
  if (byTime !== 0) {
    return byTime;
  }
  if (a.key === b.key) {
    return 0;
  }
  return a.key < b.key ? -1 : 1;
};

const evidenceKey = (evidence: ActivitySignal["evidence"]) =>
  `${evidence.type}:${evidence.id}`;

const aggregateEvidence = (
  signals: readonly ActivitySignal[],
): TimeEntrySuggestionEvidence[] => {
  const byKey = new Map<string, TimeEntrySuggestionEvidence>();
  for (const { evidence, identity } of signals) {
    const key = evidenceKey(evidence);
    const existing = byKey.get(key);
    if (evidence.type === "chat_thread") {
      if (existing?.type === "chat_thread") {
        existing.messageCount += 1;
        existing.signals.push(identity);
        continue;
      }
      byKey.set(key, {
        type: "chat_thread",
        id: evidence.id,
        title: evidence.title,
        messageCount: 1,
        signals: [identity],
      });
      continue;
    }
    if (existing?.type === "resource") {
      if (!existing.actions.includes(evidence.action)) {
        existing.actions.push(evidence.action);
      }
      existing.signals.push(identity);
      if (existing.name === null && evidence.name !== null) {
        existing.name = evidence.name;
      }
      continue;
    }
    byKey.set(key, {
      type: "resource",
      id: evidence.id,
      resourceType: evidence.resourceType,
      name: evidence.name,
      actions: [evidence.action],
      signals: [identity],
    });
  }
  return [...byKey.values()];
};

/** A non-empty run of signals: the opener is held apart so it always exists. */
type SignalRun = { first: ActivitySignal; rest: ActivitySignal[] };

const toCluster = (
  date: string,
  run: SignalRun,
  tailMinutes: number,
): SuggestionCluster => {
  const { first } = run;
  const last = run.rest.at(-1) ?? first;
  const signals = [first, ...run.rest];
  const spanMinutes = Math.ceil(
    (last.at.getTime() - first.at.getTime()) / MS_PER_MINUTE,
  );
  return {
    fingerprint: suggestionFingerprint(date, first.key),
    startedAt: first.at,
    endedAt: last.at,
    durationMinutes: spanMinutes + tailMinutes,
    signalCount: signals.length,
    evidence: aggregateEvidence(signals),
  };
};

type RecordedTime = {
  durationMinutes: number;
  startedAt: Date | null;
  endedAt: Date | null;
};

export type CoveredSuggestionCluster = SuggestionCluster & {
  alreadyCovered: boolean;
};

/**
 * Removes the union of recorded timer/activity windows from each candidate.
 * Duration-only entries cannot be placed on the clock, so they are exposed as
 * day-level coverage without being guessed into a particular window.
 */
export const subtractRecordedTime = (
  clusters: readonly SuggestionCluster[],
  entries: readonly RecordedTime[],
): CoveredSuggestionCluster[] => {
  let durationOnlyMinutes = 0;
  for (const entry of entries) {
    if (entry.startedAt === null || entry.endedAt === null) {
      durationOnlyMinutes += entry.durationMinutes;
    }
  }
  const windows = entries
    .filter(
      (entry): entry is RecordedTime & { startedAt: Date; endedAt: Date } =>
        entry.startedAt !== null && entry.endedAt !== null,
    )
    .toSorted((a, b) => a.startedAt.getTime() - b.startedAt.getTime());

  const uncovered: CoveredSuggestionCluster[] = [];
  for (const cluster of clusters) {
    const start = cluster.startedAt.getTime();
    const end = start + cluster.durationMinutes * MS_PER_MINUTE;
    const overlaps: [number, number][] = [];
    for (const window of windows) {
      const overlapStart = Math.max(start, window.startedAt.getTime());
      const overlapEnd = Math.min(end, window.endedAt.getTime());
      if (overlapEnd > overlapStart) {
        overlaps.push([overlapStart, overlapEnd]);
      }
    }
    let coveredMs = 0;
    let current: [number, number] | null = null;
    for (const overlap of overlaps) {
      if (current === null) {
        current = overlap;
      } else if (overlap[0] <= current[1]) {
        current[1] = Math.max(current[1], overlap[1]);
      } else {
        coveredMs += current[1] - current[0];
        current = overlap;
      }
    }
    if (current !== null) {
      coveredMs += current[1] - current[0];
    }
    const durationMinutes = Math.max(
      0,
      cluster.durationMinutes - Math.ceil(coveredMs / MS_PER_MINUTE),
    );
    if (durationMinutes === 0) {
      continue;
    }
    uncovered.push({
      ...cluster,
      durationMinutes,
      alreadyCovered: durationOnlyMinutes >= durationMinutes,
    });
  }
  return uncovered;
};

/**
 * Groups a day's signals into candidate entries. Signals closer than the
 * merge gap share a cluster; a cluster's duration is the observed span plus
 * a tail for the work that followed the last signal. Rounding to the billing
 * increment is not applied here: the timekeeper sees engaged minutes and the
 * accept path rounds exactly like a manual entry.
 */
export const clusterActivitySignals = ({
  date,
  signals,
  mergeGapMinutes,
  tailMinutes,
}: ClusterActivitySignalsOptions): SuggestionCluster[] => {
  const ordered = signals.toSorted(compareSignals);
  const mergeGapMs = mergeGapMinutes * MS_PER_MINUTE;
  const clusters: SuggestionCluster[] = [];
  let run: SignalRun | null = null;
  for (const signal of ordered) {
    if (run === null) {
      run = { first: signal, rest: [] };
      continue;
    }
    const previous = run.rest.at(-1) ?? run.first;
    if (signal.at.getTime() - previous.at.getTime() > mergeGapMs) {
      clusters.push(toCluster(date, run, tailMinutes));
      run = { first: signal, rest: [] };
      continue;
    }
    run.rest.push(signal);
  }
  if (run !== null) {
    clusters.push(toCluster(date, run, tailMinutes));
  }
  return clusters;
};
