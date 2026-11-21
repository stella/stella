#!/usr/bin/env bun
// How long the rehearsal's contending writer was kept out during the upgrade.
//
//   bun scripts/migration-rehearsal-writer-gap.ts <contender-log> \
//     <window-start-ms> <window-end-ms> <budget-seconds>
//
// The contender (`migration-rehearsal-db.ts contend`) prints one line per
// committed transaction and per refused lane try, per session. This reads
// those lines, keeps for each session only the window's running maximum gap
// between commits (the window's edges count as commits, so a session that
// never committed was kept out for the whole window) and its counts, and
// prints one summary cell. Exits non-zero when the longest gap is over the
// budget: an upgrade that keeps corpus writers out that long would stall
// production's ingestion and projection workers just as long.

import {
  CONTENDERS,
  WRITER_EVENT_KINDS,
} from "./migration-rehearsal-contender";
import type { WriterEventKind } from "./migration-rehearsal-contender";

export type WriterEvent = {
  kind: WriterEventKind;
  session: number;
  /** Epoch milliseconds. */
  at: number;
};

const WRITER_EVENT_PREFIX = "writer-event";

export const formatWriterEvent = ({ kind, session, at }: WriterEvent): string =>
  `${WRITER_EVENT_PREFIX} ${kind} ${String(session)} ${String(at)}`;

const isWriterEventKind = (
  value: string | undefined,
): value is WriterEventKind =>
  WRITER_EVENT_KINDS.some((kind) => kind === value);

const isWholeNumber = (value: string | undefined): value is string =>
  value !== undefined && /^\d+$/u.test(value);

/** A contender line, or null for any other line (a line cut off by the kill included). */
export const parseWriterEvent = (line: string): WriterEvent | null => {
  const [prefix, kind, session, at, ...rest] = line.trim().split(" ");
  if (
    prefix !== WRITER_EVENT_PREFIX ||
    !isWriterEventKind(kind) ||
    !isWholeNumber(session) ||
    !isWholeNumber(at) ||
    rest.length > 0
  ) {
    return null;
  }
  return { kind, session: Number(session), at: Number(at) };
};

export type WriterGapWindow = { startMs: number; endMs: number };

type SessionGap = {
  lastCommitAt: number;
  maxGapMs: number;
  commits: number;
  refusals: number;
};

export type WriterGapReport = {
  maxGapMs: number;
  commits: number;
  refusals: number;
  sessions: readonly {
    session: number;
    maxGapMs: number;
    commits: number;
    refusals: number;
  }[];
};

/**
 * The window's gaps per session, from events in log order. Every session in
 * `0..sessions-1` is reported, so one that never committed counts as kept
 * out for the whole window; events outside the window, or from a session
 * that does not exist, are ignored.
 */
export const writerGapReport = ({
  events,
  window,
  sessions,
}: {
  events: Iterable<WriterEvent>;
  window: WriterGapWindow;
  sessions: number;
}): WriterGapReport => {
  const states: SessionGap[] = Array.from({ length: sessions }, () => ({
    lastCommitAt: window.startMs,
    maxGapMs: 0,
    commits: 0,
    refusals: 0,
  }));
  for (const event of events) {
    const state = states[event.session];
    if (
      state === undefined ||
      event.at < window.startMs ||
      event.at > window.endMs
    ) {
      continue;
    }
    if (event.kind === "refused") {
      state.refusals += 1;
      continue;
    }
    state.maxGapMs = Math.max(state.maxGapMs, event.at - state.lastCommitAt);
    state.lastCommitAt = Math.max(state.lastCommitAt, event.at);
    state.commits += 1;
  }
  const reported = states.map((state, session) => ({
    session,
    maxGapMs: Math.max(state.maxGapMs, window.endMs - state.lastCommitAt),
    commits: state.commits,
    refusals: state.refusals,
  }));
  return {
    maxGapMs: Math.max(0, ...reported.map((state) => state.maxGapMs)),
    commits: reported.reduce((sum, state) => sum + state.commits, 0),
    refusals: reported.reduce((sum, state) => sum + state.refusals, 0),
    sessions: reported,
  };
};

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

export type WriterGapVerdict =
  | { kind: "within"; summary: string }
  | { kind: "over"; summary: string; message: string };

export const judgeWriterGap = (
  report: WriterGapReport,
  budgetSeconds: number,
): WriterGapVerdict => {
  const summary = `${seconds(report.maxGapMs)} of ${String(budgetSeconds)}s, ${String(report.commits)} commits, ${String(report.refusals)} lane refusals`;
  if (report.maxGapMs > budgetSeconds * 1000) {
    return {
      kind: "over",
      summary,
      message: `Corpus writers were kept out for ${seconds(report.maxGapMs)} (budget ${String(budgetSeconds)}s) during the upgrade.`,
    };
  }
  return { kind: "within", summary };
};

const parseArgs = (argv: readonly string[]) => {
  const [log, startMs, endMs, budgetSeconds, ...rest] = argv;
  if (
    log === undefined ||
    !isWholeNumber(startMs) ||
    !isWholeNumber(endMs) ||
    !isWholeNumber(budgetSeconds) ||
    rest.length > 0
  ) {
    return null;
  }
  return {
    log,
    window: { startMs: Number(startMs), endMs: Number(endMs) },
    budgetSeconds: Number(budgetSeconds),
  };
};

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    console.error(
      "Usage: bun scripts/migration-rehearsal-writer-gap.ts <contender-log> <window-start-ms> <window-end-ms> <budget-seconds>",
    );
    process.exit(2);
  }
  const lines = (await Bun.file(args.log).text()).split("\n");
  const report = writerGapReport({
    events: lines.flatMap((line) => parseWriterEvent(line) ?? []),
    window: args.window,
    sessions: CONTENDERS,
  });
  const verdict = judgeWriterGap(report, args.budgetSeconds);
  console.log(verdict.summary);
  if (verdict.kind === "over") {
    console.error(`::error::${verdict.message}`);
    process.exit(1);
  }
}
