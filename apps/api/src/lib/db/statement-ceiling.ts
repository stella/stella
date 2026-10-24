import { panic } from "better-result";
import { AsyncLocalStorage } from "node:async_hooks";

import { NODE_ENV, readRuntimeMode } from "@stll/runtime-mode";

import {
  currentQueryCounter,
  runWithQueryCounter,
} from "@/api/lib/db-query-counter";
import type { QueryCounter } from "@/api/lib/db-query-counter";

import ledger from "./statement-ceiling.json";

export const DEFAULT_STATEMENT_CEILING = 100;
export type StatementCeilingKind = keyof typeof ledger;
type StatementAllowance = { threshold: number; reason: string };
export type StatementCeilingLedger = Record<
  StatementCeilingKind,
  Record<string, StatementAllowance>
>;

const scope = new AsyncLocalStorage<{
  kind: StatementCeilingKind;
  key: string;
}>();
export const activeStatementCeiling = () => scope.getStore();

const diagnostics = (counter: Readonly<QueryCounter>) =>
  [...counter.fingerprints.entries()]
    .toSorted(([, left], [, right]) => right - left)
    .slice(0, 5)
    .map(([fingerprint, count]) => `${count} × ${fingerprint}`)
    .join("\n");

/** One monitor owns a test process; observations are maxima across invocations. */
export const createStatementCeilingMonitor = (
  allowances: StatementCeilingLedger,
) => {
  const observed = new Map<string, number>();
  const violations = new Set<string>();
  for (const [kind, entries] of Object.entries(allowances)) {
    for (const [key, entry] of Object.entries(entries)) {
      if (
        !Number.isSafeInteger(entry.threshold) ||
        entry.threshold <= DEFAULT_STATEMENT_CEILING ||
        entry.reason.trim().length === 0
      ) {
        panic(`Invalid statement ceiling allowance: ${kind} ${key}`);
      }
    }
  }
  const record = ({
    kind,
    key,
    counter,
  }: {
    kind: StatementCeilingKind;
    key: string;
    counter: Readonly<QueryCounter>;
  }) => {
    const identity = `${kind} ${key}`;
    const statements = counter.count + counter.transactions;
    observed.set(identity, Math.max(observed.get(identity) ?? 0, statements));
    const threshold =
      allowances[kind][key]?.threshold ?? DEFAULT_STATEMENT_CEILING;
    if (statements <= threshold) {
      return;
    }
    const message = `Statement ceiling exceeded: ${identity}: ${statements} statements (${counter.transactions} transaction round trips), threshold ${threshold}\n${diagnostics(counter)}`;
    // Frameworks may translate exceptions into HTTP/MCP errors or failed jobs.
    // Retain the violation so the test-runtime finalizer still fails the spec.
    violations.add(message);
    panic(message);
  };
  const assertSatisfied = () => {
    const failures = [...violations];
    for (const [kind, entries] of Object.entries(allowances)) {
      for (const [key, { threshold }] of Object.entries(entries)) {
        const count = observed.get(`${kind} ${key}`);
        // An unexercised route is not evidence that its allowance is stale.
        if (count !== undefined && count < threshold) {
          failures.push(
            `Stale statement ceiling: ${kind} ${key}: threshold ${threshold}, observed maximum ${count}; ${count <= DEFAULT_STATEMENT_CEILING ? "remove allowance" : `lower threshold to ${count}`}`,
          );
        }
      }
    }
    if (failures.length > 0) {
      panic(failures.join("\n"));
    }
  };
  return { record, assertSatisfied, observed };
};

const monitor = createStatementCeilingMonitor(ledger);
export const assertStatementCeilingsSatisfied = () => monitor.assertSatisfied();
export const statementCeilingMeasurements = () =>
  Object.fromEntries(monitor.observed);

type StatementCeilingOptions<T> = {
  kind: StatementCeilingKind;
  key: string;
  run: () => T | Promise<T>;
};

export const runWithStatementCeiling = async <T>({
  kind,
  key,
  run: fn,
}: StatementCeilingOptions<T>): Promise<T> => {
  if (readRuntimeMode().nodeEnv !== NODE_ENV.test) {
    return await fn();
  }
  const run = async () => {
    const counter = currentQueryCounter();
    if (counter === undefined) {
      panic("A statement ceiling must run inside its query counter");
    }
    counter.diagnostics = true;
    // Stream continuations can issue SQL after their Response is returned.
    // Keep the guard on the store for its entire async lifetime.
    counter.onQuery = () => monitor.record({ kind, key, counter });
    return await scope.run({ kind, key }, async () => {
      try {
        return await fn();
      } finally {
        monitor.record({ kind, key, counter });
      }
    });
  };
  const active = currentQueryCounter();
  if (kind === "request" && active !== undefined) {
    return await run();
  }
  return await runWithQueryCounter(run);
};
