import { panic, Result, TaggedError } from "better-result";
import { sql } from "drizzle-orm";

import { withTimeout } from "@stll/concurrency/with-timeout";

import type { Transaction } from "@/api/db/root";
import { setSharedStatementTimeout } from "@/api/db/shared-pool-timeouts";
import { getPgErrorCode, PG_ERROR } from "@/api/lib/pg-error";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

type Actor = "a" | "b";
export type InterleavingToken = `${Actor}.${string}`;
type Step = {
  name: string;
  /** Application waits must consume the signal and settle after cancellation. */
  run: (tx: Transaction, signal: AbortSignal) => Promise<unknown>;
};
type Participant = {
  steps: readonly Step[];
  transaction?: <T>(run: (tx: Transaction) => Promise<T>) => Promise<T>;
};
type TransactionOutcome =
  | { status: "committed" }
  | {
      status: "serialization-error" | "deadlock" | "app-error";
      error: unknown;
    };
export type InterleavingResult<State> = {
  schedule: readonly InterleavingToken[];
  executed: InterleavingToken[];
  blocked: InterleavingToken[];
  sessions: Record<Actor, { pid: number; xid: string }>;
  outcomes: Record<Actor, TransactionOutcome>;
  state: State;
};
export class InterleavingTimeout extends TaggedError("InterleavingTimeout")<{
  message: string;
}> {}

const CANCELLATION_TIMEOUT_MS = 2000;

type InterleavingOptions<State> = {
  databaseUrl: string;
  a: Participant;
  b: Participant;
  schedules?: readonly (readonly InterleavingToken[])[];
  reset: () => Promise<void>;
  readState: () => Promise<State>;
  invariant: (result: InterleavingResult<State>) => void | Promise<void>;
  timeoutMs?: number;
};

/** Commit is a scheduled boundary: locks remain held after the last query. */
export const enumerateInterleavings = (
  a: readonly string[],
  b: readonly string[],
): InterleavingToken[][] => {
  const schedules: InterleavingToken[][] = [];
  const visit = (ai: number, bi: number, prefix: InterleavingToken[]) => {
    if (ai === a.length && bi === b.length) {
      schedules.push(prefix);
      return;
    }
    const left = a.at(ai);
    const right = b.at(bi);
    if (left !== undefined) {
      visit(ai + 1, bi, [...prefix, `a.${left}`]);
    }
    if (right !== undefined) {
      visit(ai, bi + 1, [...prefix, `b.${right}`]);
    }
  };
  visit(0, 0, []);
  return schedules;
};

const stepNames = ({ steps }: Participant) => {
  const names = steps.map(({ name }) => name);
  if (
    names.some((name) => name.length === 0) ||
    names.includes("commit") ||
    new Set(names).size !== names.length
  ) {
    panic("Interleaving steps need unique names; commit is reserved");
  }
  return [...names, "commit"];
};

/** Runs real transactions without retries, yielding only at declared boundaries. */
export const withInterleaving = async <State>({
  databaseUrl,
  a,
  b,
  schedules,
  reset,
  readState,
  invariant,
  timeoutMs = 5000,
}: InterleavingOptions<State>): Promise<InterleavingResult<State>[]> => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    panic("Interleaving requires a positive finite deadline");
  }
  const names = { a: stepNames(a), b: stepNames(b) };
  const selected = schedules ?? enumerateInterleavings(names.a, names.b);
  if (selected.length === 0) {
    panic("Interleaving requires at least one schedule");
  }
  for (const schedule of selected) {
    if (schedule.length !== names.a.length + names.b.length) {
      panic("Schedule contains unexpected steps");
    }
    for (const actor of ["a", "b"] as const) {
      const actual = schedule.filter((token) => token.startsWith(`${actor}.`));
      if (
        actual.join("\n") !==
        names[actor].map((name) => `${actor}.${name}`).join("\n")
      ) {
        panic(
          "Schedule must contain every step and commit in participant order",
        );
      }
    }
  }
  const results: InterleavingResult<State>[] = [];
  for (const schedule of selected) {
    await reset();
    const result = await withGatedTestClients(
      databaseUrl,
      async ({ openClient }) => {
        const observer = openClient();
        const connections = { a: openClient(), b: openClient() };
        const ready = {
          a: Promise.withResolvers<{ pid: number; xid: string }>(),
          b: Promise.withResolvers<{ pid: number; xid: string }>(),
        };
        const gates = new Map<
          InterleavingToken,
          ReturnType<typeof Promise.withResolvers<undefined>>
        >();
        const completed = new Set<InterleavingToken>();
        const executed: InterleavingToken[] = [];
        const blocked: InterleavingToken[] = [];
        const outcomes = new Map<Actor, TransactionOutcome>();
        const controller = new AbortController();
        // Backends running a caller step: the only statements cancellation targets.
        const stepPids = new Set<number>();
        const stepTasks: Promise<unknown>[] = [];
        const timeout = Promise.withResolvers<never>();
        const timer = setTimeout(() => {
          const error = new InterleavingTimeout({
            message: "Interleaving exceeded its deadline",
          });
          controller.abort(error);
          timeout.reject(error);
        }, timeoutMs);
        const bounded = async <T>(work: PromiseLike<T>) =>
          Promise.race([work, timeout.promise]);
        let stopped = false;
        // A cancel that reaches a backend while it runs COMMIT or ROLLBACK
        // aborts that statement and leaves the caller's connection in a failed
        // transaction block. Cancels therefore target only running steps, and
        // once aborted, actors end their transactions only after every cancel
        // has been sent; an idle backend then discards the cancel.
        const cancellationSent = Promise.withResolvers<undefined>();
        const afterCancellation = async () => {
          if (controller.signal.aborted) {
            await cancellationSent.promise;
          }
        };
        for (const token of schedule) {
          gates.set(token, Promise.withResolvers<undefined>());
        }
        const tasks = (["a", "b"] as const).map(async (actor) => {
          const participant = actor === "a" ? a : b;
          const transaction =
            participant.transaction ??
            connections[actor].db.transaction.bind(connections[actor].db);
          const outcome = await Result.tryPromise(
            async () =>
              await transaction(async (tx) => {
                await setSharedStatementTimeout(tx, timeoutMs);
                const identity = await tx
                  .select({
                    pid: sql<number>`pg_backend_pid()`,
                    xid: sql<string>`txid_current()::text`,
                  })
                  .from(sql`(SELECT 1) AS identity`);
                const session =
                  identity.at(0) ?? panic("Transaction identity missing");
                ready[actor].resolve(session);
                for (const step of participant.steps) {
                  const token: InterleavingToken = `${actor}.${step.name}`;
                  await (gates.get(token) ?? panic("Step gate missing"))
                    .promise;
                  await afterCancellation();
                  if (stopped) {
                    throw new InterleavingTimeout({
                      message: "Interleaving exceeded its deadline",
                    });
                  }
                  stepPids.add(session.pid);
                  try {
                    const stepTask = step.run(tx, controller.signal);
                    stepTasks.push(stepTask);
                    await stepTask;
                  } finally {
                    await afterCancellation();
                    stepPids.delete(session.pid);
                  }
                  completed.add(token);
                }
                await (
                  gates.get(`${actor}.commit`) ?? panic("Commit gate missing")
                ).promise;
                await afterCancellation();
                if (stopped) {
                  throw new InterleavingTimeout({
                    message: "Interleaving exceeded its deadline",
                  });
                }
              }),
          );
          if (outcome.isOk()) {
            outcomes.set(actor, { status: "committed" });
          } else {
            const errorCode = getPgErrorCode(outcome.error);
            if (errorCode === PG_ERROR.DEADLOCK_DETECTED) {
              outcomes.set(actor, { status: "deadlock", error: outcome.error });
            } else if (errorCode === PG_ERROR.SERIALIZATION_FAILURE) {
              outcomes.set(actor, {
                status: "serialization-error",
                error: outcome.error,
              });
            } else {
              outcomes.set(actor, {
                status: "app-error",
                error: outcome.error,
              });
            }
            ready[actor].reject(outcome.error);
          }
          completed.add(`${actor}.commit`);
        });
        const deadline = performance.now() + timeoutMs;
        const checkDeadline = () => {
          if (performance.now() >= deadline) {
            throw new InterleavingTimeout({
              message: "Interleaving exceeded its deadline",
            });
          }
        };
        try {
          // Both identities are read inside BEGIN before any caller step is released.
          const identities = await bounded(
            Promise.all([ready.a.promise, ready.b.promise]),
          );
          const sessions = { a: identities[0], b: identities[1] };
          const remaining = [...schedule];
          const pending = new Map<Actor, InterleavingToken>();
          while (remaining.length > 0 || pending.size > 0) {
            checkDeadline();
            for (const [actor, token] of pending) {
              if (completed.has(token) || outcomes.get(actor)) {
                pending.delete(actor);
              }
            }
            const next = remaining.findIndex(
              (token) => !pending.has(token.startsWith("a.") ? "a" : "b"),
            );
            if (next === -1) {
              await Bun.sleep(5);
              continue;
            }
            const token =
              remaining.splice(next, 1).at(0) ??
              panic("Schedule token missing");
            const actor = token.startsWith("a.") ? "a" : "b";
            if (outcomes.get(actor)) {
              continue;
            }
            executed.push(token);
            (gates.get(token) ?? panic("Step gate missing")).resolve(undefined);
            pending.set(actor, token);
            while (!completed.has(token) && !outcomes.get(actor)) {
              checkDeadline();
              const rows = await bounded(
                observer.sql<
                  { blocked: boolean }[]
                >`SELECT cardinality(pg_blocking_pids(${sessions[actor].pid})) > 0 AS blocked`,
              );
              if (rows.at(0)?.blocked) {
                blocked.push(token);
                break;
              }
              await Bun.sleep(5);
            }
          }
          await bounded(Promise.all(tasks));
          const first =
            outcomes.get("a") ?? panic("First transaction outcome missing");
          const second =
            outcomes.get("b") ?? panic("Second transaction outcome missing");
          return {
            schedule,
            executed,
            blocked,
            sessions,
            outcomes: { a: first, b: second },
            state: await bounded(readState()),
          };
        } finally {
          stopped = true;
          if (!outcomes.get("a") || !outcomes.get("b")) {
            controller.abort(
              new InterleavingTimeout({
                message: "Interleaving exceeded its deadline",
              }),
            );
          }
          for (const gate of gates.values()) {
            gate.resolve(undefined);
          }
          try {
            await withTimeout(
              async () => {
                try {
                  for (const pid of stepPids) {
                    await observer.sql`SELECT pg_cancel_backend(${pid})`;
                  }
                } finally {
                  cancellationSent.resolve(undefined);
                }
                // The schedule deadline has expired; cleanup has its own budget.
                await Promise.allSettled([...stepTasks, ...tasks]);
              },
              {
                label: "Interleaving cancellation",
                timeoutMs: CANCELLATION_TIMEOUT_MS,
              },
            );
          } finally {
            clearTimeout(timer);
          }
        }
      },
      { closeTimeout: 0 },
    );
    results.push(result);
    await invariant(result);
  }
  return results;
};
