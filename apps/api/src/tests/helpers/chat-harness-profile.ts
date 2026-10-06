import { panic } from "better-result";
import type { Logger } from "drizzle-orm";
import { AsyncLocalStorage } from "node:async_hooks";

import { queryCountLogger } from "@/api/lib/db-query-counter";

export const CHAT_HARNESS_PHASES = [
  "fixture",
  "prepare",
  "clientSetup",
  "action",
  "settlement",
  "webSettlement",
  "oracle",
  "replay",
  "close",
  "unattributed",
] as const;

export type ChatHarnessPhase = (typeof CHAT_HARNESS_PHASES)[number];
type PhaseTotals = {
  calls: number;
  inclusiveMs: number;
  selfMs: number;
  statements: number;
  kinds: { read: number; write: number; other: number };
};
type Span = {
  phase: ChatHarnessPhase;
  parent: Span | undefined;
  active: boolean;
  activeChildren: number;
  childBusyStarted: number;
  childBusyMs: number;
};
type ChatHarnessProfileOptions = { now?: () => number };

export const createChatHarnessProfile = (
  file: string,
  { now = () => performance.now() }: ChatHarnessProfileOptions = {},
) => {
  const started = now();
  const store = new AsyncLocalStorage<Span>();
  const totals = new Map<ChatHarnessPhase, PhaseTotals>();
  for (const phase of CHAT_HARNESS_PHASES) {
    totals.set(phase, {
      calls: 0,
      inclusiveMs: 0,
      selfMs: 0,
      statements: 0,
      kinds: { read: 0, write: 0, other: 0 },
    });
  }
  const phaseTotals = (phase: ChatHarnessPhase) => {
    const total = totals.get(phase);
    if (total === undefined) {
      panic(`Missing chat harness phase: ${phase}`);
    }
    return total;
  };
  const closestActiveSpan = () => {
    let span = store.getStore();
    while (span !== undefined && !span.active) {
      span = span.parent;
    }
    return span;
  };
  const logger = {
    logQuery: (query, params) => {
      queryCountLogger.logQuery(query, params);
      const span = closestActiveSpan();
      const total = phaseTotals(span?.phase ?? "unattributed");
      const keyword =
        /^\w+/u.exec(query.trimStart())?.at(0)?.toLowerCase() ?? "";
      total.statements += 1;
      switch (keyword) {
        case "select":
          total.kinds.read += 1;
          break;
        case "insert":
        case "update":
        case "delete":
          total.kinds.write += 1;
          break;
        default:
          total.kinds.other += 1;
      }
    },
  } satisfies Logger;
  const measure = async <T>(
    phase: ChatHarnessPhase,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const parent = closestActiveSpan();
    if (parent?.phase === phase) {
      return await operation();
    }
    const began = now();
    if (parent !== undefined && parent.activeChildren++ === 0) {
      parent.childBusyStarted = began;
    }
    const span: Span = {
      phase,
      parent,
      active: true,
      activeChildren: 0,
      childBusyStarted: 0,
      childBusyMs: 0,
    };
    const total = phaseTotals(phase);
    total.calls += 1;
    return store.run(span, async () => {
      try {
        return await operation();
      } finally {
        const ended = now();
        span.active = false;
        const childBusy =
          span.childBusyMs +
          (span.activeChildren > 0 ? ended - span.childBusyStarted : 0);
        total.inclusiveMs += ended - began;
        total.selfMs += ended - began - childBusy;
        if (
          parent !== undefined &&
          parent.active &&
          --parent.activeChildren === 0
        ) {
          parent.childBusyMs += ended - parent.childBusyStarted;
        }
      }
    });
  };
  const summary = () => ({
    file,
    elapsedMs: now() - started,
    statements: [...totals.values()].reduce(
      (sum, phase) => sum + phase.statements,
      0,
    ),
    timing:
      "inclusive and self totals may overlap across concurrent siblings; self excludes only the union of direct child durations",
    statementsScope:
      "Drizzle statements after logger attachment; excludes raw driver SQL and fixture creation before attachment",
    replayScope:
      "cassette request parsing, matching and response construction; streamed bodies and SDK work remain caller phases",
    phases: CHAT_HARNESS_PHASES.map((phase) => {
      const total = phaseTotals(phase);
      return { phase, ...total, kinds: { ...total.kinds } };
    }),
  });
  const report = () =>
    process.stdout.write(`CHAT_HARNESS_PROFILE ${JSON.stringify(summary())}\n`);
  return { measure, logger, summary, report };
};

export type ChatHarnessProfile = ReturnType<typeof createChatHarnessProfile>;
