import type { TimeEntrySuggestionEvidence } from "@stll/api-contract/time-entry-types";

/**
 * One observed action by the timekeeper inside a matter. `key` is unique per
 * signal and orders ties, so clustering is deterministic for equal instants.
 */
export type ActivitySignal = {
  at: Date;
  key: string;
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
 * cluster keeps its fingerprint while later signals extend it, and a decision
 * recorded against it stays attached. Two clusters that merge keep the
 * earlier one's identity; the later one's fingerprint stops being produced.
 */
export const suggestionFingerprint = (date: string, firstKey: string) =>
  new Bun.CryptoHasher("sha256").update(`${date}\n${firstKey}`).digest("hex");

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
  for (const { evidence } of signals) {
    const key = evidenceKey(evidence);
    const existing = byKey.get(key);
    if (evidence.type === "chat_thread") {
      if (existing?.type === "chat_thread") {
        existing.messageCount += 1;
        continue;
      }
      byKey.set(key, {
        type: "chat_thread",
        id: evidence.id,
        title: evidence.title,
        messageCount: 1,
      });
      continue;
    }
    if (existing?.type === "resource") {
      if (!existing.actions.includes(evidence.action)) {
        existing.actions.push(evidence.action);
      }
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
