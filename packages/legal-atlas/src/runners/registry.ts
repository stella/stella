import { panic } from "better-result";

export type RunnerStatus = "reserved" | "implemented";

const RUNNER_DEFINITIONS = [
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
    name: "legal-corpus-storage-backfill",
    status: "implemented",
    description: "copy existing case-law and legislation payloads to S3",
  },
  {
    name: "legal-corpus-index-backfill",
    status: "implemented",
    description: "index corpus-backed case-law and legislation payloads",
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
] as const satisfies readonly {
  description: string;
  name: string;
  status: RunnerStatus;
}[];

export type RunnerName = (typeof RUNNER_DEFINITIONS)[number]["name"];

export type RunnerDefinition = {
  name: RunnerName;
  status: RunnerStatus;
  description: string;
};

export const RUNNER_NAMES: readonly RunnerName[] = RUNNER_DEFINITIONS.map(
  ({ name }) => name,
);

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
