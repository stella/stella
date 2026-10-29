import { panic } from "better-result";

import type { Verdict } from "@stll/db-load-gate/health";

import { envBase } from "@/api/env-base";
import type { SafeId } from "@/api/lib/branded-types";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import type { ApiLatencyAdmission } from "@/api/lib/observability/api-latency-admission";

import { VISITED_REPLAY_ADMISSION_LIMITS } from "./replay-priority";

export const VISITED_REPLAY_LIMITS = {
  maxSources: Object.keys(ADAPTER_KEYS).length,
  pendingPerSource: VISITED_REPLAY_ADMISSION_LIMITS.batchRows,
  admissionsPerMinute: VISITED_REPLAY_ADMISSION_LIMITS.rowsPerSourceMinute,
  windowMs: VISITED_REPLAY_ADMISSION_LIMITS.minuteMs,
} as const;

/** Every ceiling drops the new hint and preserves the pending identities. */
export const VISITED_REPLAY_DROP_REASON = {
  SOURCE_CEILING: "source-ceiling",
  PENDING_CEILING: "pending-ceiling",
  RATE_CEILING: "rate-ceiling",
} as const;
export type VisitedReplayDropReason =
  (typeof VISITED_REPLAY_DROP_REASON)[keyof typeof VISITED_REPLAY_DROP_REASON];

/** A read nominates an identity; only the writer may classify it as stale. */
export type VisitedReplayCandidate = {
  sourceId: SafeId<"caseLawSource">;
  decisionId: SafeId<"caseLawDecision">;
};

type SourceSignals = {
  pending: Map<SafeId<"caseLawDecision">, VisitedReplayCandidate>;
  admissionTimes: number[];
  nextAdmission: number;
};

type VisitedReplayOptions = {
  now?: () => number;
  usesLocalCorpus?: () => boolean;
};

type FlushVisitedReplayOptions = {
  readVerdict: () => Promise<Verdict>;
  readLatencyAdmission: () => ApiLatencyAdmission;
  enqueueBatch: (signals: readonly VisitedReplayCandidate[]) => Promise<void>;
  maxDurationMs: number;
};

/**
 * Read paths only offer hints, synchronously. The governed task can flush
 * them into the replay queue; the durable full sweep recovers discarded hints
 * and a process restart. Nothing here owns replay progress or claims.
 */
export const createVisitedReplaySignals = ({
  now = () => performance.now(),
  usesLocalCorpus = () => envBase.PUBLIC_LAW_DATABASE_URL === undefined,
}: VisitedReplayOptions = {}) => {
  const sources = new Map<SafeId<"caseLawSource">, SourceSignals>();

  return {
    offer: (candidate: VisitedReplayCandidate) => {
      if (!usesLocalCorpus()) {
        return "external-corpus" as const;
      }
      let source = sources.get(candidate.sourceId);
      if (source === undefined) {
        if (sources.size >= VISITED_REPLAY_LIMITS.maxSources) {
          return VISITED_REPLAY_DROP_REASON.SOURCE_CEILING;
        }
        source = { pending: new Map(), admissionTimes: [], nextAdmission: 0 };
        sources.set(candidate.sourceId, source);
      }
      if (source.pending.has(candidate.decisionId)) {
        return "deduplicated" as const;
      }
      if (source.pending.size >= VISITED_REPLAY_LIMITS.pendingPerSource) {
        return VISITED_REPLAY_DROP_REASON.PENDING_CEILING;
      }
      const observedAt = now();
      const oldest = source.admissionTimes.at(source.nextAdmission);
      if (
        source.admissionTimes.length >=
          VISITED_REPLAY_LIMITS.admissionsPerMinute &&
        oldest !== undefined &&
        oldest > observedAt - VISITED_REPLAY_LIMITS.windowMs
      ) {
        return VISITED_REPLAY_DROP_REASON.RATE_CEILING;
      }
      if (
        source.admissionTimes.length < VISITED_REPLAY_LIMITS.admissionsPerMinute
      ) {
        source.admissionTimes.push(observedAt);
      } else {
        source.admissionTimes[source.nextAdmission] = observedAt;
        source.nextAdmission =
          (source.nextAdmission + 1) %
          VISITED_REPLAY_LIMITS.admissionsPerMinute;
      }
      source.pending.set(candidate.decisionId, candidate);
      return "buffered" as const;
    },
    flush: async ({
      readVerdict,
      readLatencyAdmission,
      enqueueBatch,
      maxDurationMs,
    }: FlushVisitedReplayOptions) => {
      if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0) {
        panic("Visited replay flush duration must be finite and positive");
      }
      if (!usesLocalCorpus()) {
        return { status: "external-corpus", flushed: 0 } as const;
      }
      const deadline = now() + maxDurationMs;
      let flushed = 0;
      for (const [sourceId, source] of sources) {
        if (now() >= deadline) {
          return { status: "time-limit", flushed } as const;
        }
        const batch = Array.from(source.pending.values());
        if (batch.length > 0) {
          const verdict = await readVerdict();
          if (verdict.kind !== "normal") {
            return { status: "held", reason: "database", flushed } as const;
          }
          if (readLatencyAdmission().status !== "admit") {
            return { status: "held", reason: "latency", flushed } as const;
          }
          if (!usesLocalCorpus()) {
            return { status: "external-corpus", flushed } as const;
          }
          await enqueueBatch(batch);
          for (const candidate of batch) {
            source.pending.delete(candidate.decisionId);
          }
          flushed += batch.length;
        }
        const latest = source.admissionTimes.at(
          (source.nextAdmission + source.admissionTimes.length - 1) %
            VISITED_REPLAY_LIMITS.admissionsPerMinute,
        );
        if (
          source.pending.size === 0 &&
          latest !== undefined &&
          latest <= now() - VISITED_REPLAY_LIMITS.windowMs
        ) {
          sources.delete(sourceId);
        }
      }
      return { status: "complete", flushed } as const;
    },
  };
};

let visitedSignals: ReturnType<typeof createVisitedReplaySignals> | undefined;
export const getVisitedReplaySignals = () => {
  visitedSignals ??= createVisitedReplaySignals();
  return visitedSignals;
};
