import { expect, test } from "bun:test";

import {
  POSTGRES_MAX_SHARDS,
  POSTGRES_SHARD_TEST_BUDGET_SECONDS,
} from "../packages/scripts/src/test-shard-planning";
import { postgresShardOutputs } from "./ci-postgres-shard-plan";

const unwrapOutputs = (result: ReturnType<typeof postgresShardOutputs>) => {
  expect(result.status).toBe("ok");
  if (result.status === "invalid") {
    throw new Error(result.message);
  }
  return result.value;
};

const suite = (fileCount: number, seconds: number) => {
  const files = Array.from({ length: fileCount }, (_, index) => `${index}`);
  return {
    files,
    durations: Object.fromEntries(files.map((file) => [file, seconds])),
  };
};

const parseOutputs = (output: string) =>
  Object.fromEntries(
    output
      .trimEnd()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );

test("the matrix output follows measured time and names its own n", () => {
  const budget = POSTGRES_SHARD_TEST_BUDGET_SECONDS;
  const fits = parseOutputs(
    unwrapOutputs(postgresShardOutputs(suite(24, budget / 8))).output,
  );
  expect(fits).toEqual({
    postgres_shards: '["1/3","2/3","3/3"]',
    postgres_shard_count: "3",
  });
  // One more file past three budgets plans a fourth shard, not a failure.
  const grown = unwrapOutputs(postgresShardOutputs(suite(25, budget / 8)));
  expect(parseOutputs(grown.output)).toEqual({
    postgres_shards: '["1/4","2/4","3/4","4/4"]',
    postgres_shard_count: "4",
  });
  expect(grown.warnings).toEqual([]);
});

test("a suite beyond the maximum keeps the maximum and warns", () => {
  const capped = unwrapOutputs(
    postgresShardOutputs(
      suite(POSTGRES_MAX_SHARDS * 4, POSTGRES_SHARD_TEST_BUDGET_SECONDS / 2),
    ),
  );
  const outputs = parseOutputs(capped.output);
  expect(outputs["postgres_shard_count"]).toBe(String(POSTGRES_MAX_SHARDS));
  expect(JSON.parse(outputs["postgres_shards"] ?? "[]")).toHaveLength(
    POSTGRES_MAX_SHARDS,
  );
  expect(capped.warnings).toHaveLength(POSTGRES_MAX_SHARDS);
  expect(capped.summary).toContain(`${POSTGRES_MAX_SHARDS} shards`);
});

test("an empty gated suite fails planning so CI keeps its maximum-shard fallback", () => {
  expect(postgresShardOutputs({ files: [], durations: {} })).toEqual({
    status: "invalid",
    message: "No Postgres-gated test files discovered",
  });
});
