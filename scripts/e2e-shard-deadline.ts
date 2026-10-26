import { panic } from "better-result";
import * as v from "valibot";

import configuredBudgets from "./code-quality-task-budgets.json" with { type: "json" };

const CLEANUP_MARGIN_SECONDS = 30;

export const measuredShardBudget = (shard: number) => {
  // The four-way plan subdivides each measured two-way lane. Until the timing
  // cache accumulates direct samples, inherit the parent lane's conservative
  // ceiling rather than inventing a shorter watchdog.
  const measuredParentShard = Math.ceil(shard / 2);
  const samples = configuredBudgets.e2eProductionShards.samples
    .filter((sample) => sample.shard === measuredParentShard)
    .map((sample) => sample.seconds)
    .toSorted((left, right) => left - right);
  const p50 = samples.at(Math.ceil(samples.length * 0.5) - 1);
  const p95 = samples.at(Math.ceil(samples.length * 0.95) - 1);
  const largest = samples.at(-1);
  if (p50 === undefined || p95 === undefined || largest === undefined) {
    return panic(`Shard ${shard} needs successful wall-time measurements`);
  }
  const seconds = Math.ceil(Math.max(p95 * 1.5, largest * 2));
  return {
    p50,
    p95,
    seconds,
    minutes: Math.ceil((seconds + CLEANUP_MARGIN_SECONDS) / 60),
  };
};

export const shardBudgetViolation = (shard: number, elapsedSeconds: number) => {
  const budget = measuredShardBudget(shard);
  return elapsedSeconds > budget.seconds
    ? `Shard ${shard} took ${elapsedSeconds}s, exceeding its measured ${budget.seconds}s budget (p95 ${budget.p95}s); remeasure or rebalance the split`
    : undefined;
};

if (import.meta.main) {
  const shard = v.parse(
    v.pipe(v.number(), v.integer(), v.minValue(1)),
    Number(process.argv.at(3)),
  );
  const mode = process.argv.at(2);
  if (mode !== "--minutes" && mode !== "--check") {
    panic(
      "Usage: e2e-shard-deadline.ts --minutes <shard> | --check <shard> <elapsed-seconds>",
    );
  }
  switch (mode) {
    case "--minutes":
      console.log(measuredShardBudget(shard).minutes);
      break;
    case "--check": {
      const elapsedSeconds = v.parse(
        v.pipe(v.number(), v.integer(), v.minValue(0)),
        Number(process.argv.at(4)),
      );
      const violation = shardBudgetViolation(shard, elapsedSeconds);
      if (violation !== undefined) {
        console.error(`::error::${violation}`);
        process.exit(1);
      }
      break;
    }
  }
}
