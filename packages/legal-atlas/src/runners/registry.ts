import { panic } from "better-result";

export const RUNNER_NAMES = [
  "case-law-ingest",
  "case-law-corpus-storage-backfill",
  "statute-ingest",
  "search-index",
] as const;

export type RunnerName = (typeof RUNNER_NAMES)[number];
export type RunnerStatus = "reserved" | "implemented";

export type RunnerDefinition = {
  name: RunnerName;
  status: RunnerStatus;
  description: string;
};

const RUNNER_DEFINITIONS: readonly RunnerDefinition[] = [
  {
    name: "case-law-ingest",
    status: "implemented",
    description: "case-law source ingestion daemon",
  },
  {
    name: "case-law-corpus-storage-backfill",
    status: "implemented",
    description: "copy existing case-law text payloads from Postgres to S3",
  },
  {
    name: "statute-ingest",
    status: "reserved",
    description: "statutory text source ingestion and normalization",
  },
  {
    name: "search-index",
    status: "reserved",
    description:
      "corpus indexing projection into the configured search backend",
  },
];

const RUNNER_NAME_SET: ReadonlySet<string> = new Set(RUNNER_NAMES);

export const getRunnerDefinitions = (): readonly RunnerDefinition[] =>
  RUNNER_DEFINITIONS;

export const isRunnerName = (val: unknown): val is RunnerName =>
  typeof val === "string" && RUNNER_NAME_SET.has(val);

export const getRunnerDefinition = (name: RunnerName): RunnerDefinition => {
  const runner = RUNNER_DEFINITIONS.find(
    (candidate) => candidate.name === name,
  );
  if (!runner) {
    panic(`Runner registry is missing ${name}`);
  }
  return runner;
};
