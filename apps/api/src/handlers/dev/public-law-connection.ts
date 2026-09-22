import { Result } from "better-result";
import { sql } from "drizzle-orm";
import { tmpdir } from "node:os";
import path from "node:path";

import { env } from "@/api/env";
import {
  probeCorpusIndexSearchLiveness,
  readCorpusIndexSearchBaseUrl,
} from "@/api/lib/legal-search/corpus-index-client";
import { publicLawReadDb } from "@/api/lib/public-law-read-db";
import { withTimeout } from "@/api/lib/with-timeout";

/**
 * Dev menu "Connect case law": runs a local command (outside the repository)
 * that makes the public-law corpus reachable, then proves it by reading
 * through the same database pool and search endpoint the API serves from.
 * The endpoints come from env at boot, so connecting never needs a restart.
 */

const CONNECT_COMMAND_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 5000;
const FAILURE_TAIL_CHARS = 500;
const SEARCH_CLUSTER = "q09";

type PublicLawConnection =
  | {
      status: "unconfigured";
      missing:
        | "DEV_PUBLIC_LAW_CONNECT_COMMAND"
        | "PUBLIC_LAW_DATABASE_URL"
        | "CORPUS_INDEX_Q09_SEARCH_ENDPOINT";
    }
  | { status: "connecting" }
  | { status: "connected" }
  | { status: "disconnected"; reason: string }
  | { status: "failed"; message: string };

type ConnectionConfig =
  | { status: "configured"; command: string }
  | Extract<PublicLawConnection, { status: "unconfigured" }>;

type ProbeOutcome =
  | { status: "reachable" }
  | { status: "unreachable"; reason: string };

let connectRun: Promise<void> | null = null;
let lastFailure: string | null = null;

const readConfig = (): ConnectionConfig => {
  const command = env.DEV_PUBLIC_LAW_CONNECT_COMMAND;
  if (command === undefined) {
    return {
      status: "unconfigured",
      missing: "DEV_PUBLIC_LAW_CONNECT_COMMAND",
    };
  }
  // Without it the API reads public law from DATABASE_URL: nothing to connect.
  if (env.PUBLIC_LAW_DATABASE_URL === undefined) {
    return { status: "unconfigured", missing: "PUBLIC_LAW_DATABASE_URL" };
  }
  if (readCorpusIndexSearchBaseUrl(SEARCH_CLUSTER) === null) {
    return {
      status: "unconfigured",
      missing: "CORPUS_INDEX_Q09_SEARCH_ENDPOINT",
    };
  }
  return { status: "configured", command };
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// A listener that outlived its remote session accepts connections and then
// hangs, so reachability means a completed round trip, not an open port.
const probeDatabase = async (): Promise<ProbeOutcome> => {
  const result = await Result.tryPromise({
    try: async () =>
      await withTimeout(
        async () =>
          await publicLawReadDb(async (tx) => await tx.execute(sql`SELECT 1`)),
        { label: "public-law database probe", timeoutMs: PROBE_TIMEOUT_MS },
      ),
    catch: errorMessage,
  });
  return result.isOk()
    ? { status: "reachable" }
    : { status: "unreachable", reason: `Database: ${result.error}` };
};

const probeSearch = async (): Promise<ProbeOutcome> => {
  const result = await Result.tryPromise({
    try: async () =>
      await probeCorpusIndexSearchLiveness(SEARCH_CLUSTER, PROBE_TIMEOUT_MS),
    catch: errorMessage,
  });
  if (result.isErr()) {
    return { status: "unreachable", reason: `Search: ${result.error}` };
  }
  return result.value.ok
    ? { status: "reachable" }
    : {
        status: "unreachable",
        reason: `Search: HTTP ${String(result.value.status)}`,
      };
};

const probeCorpus = async (): Promise<ProbeOutcome> => {
  const outcomes = await Promise.all([probeDatabase(), probeSearch()]);
  const reasons = outcomes.flatMap((outcome) =>
    outcome.status === "unreachable" ? [outcome.reason] : [],
  );
  return reasons.length === 0
    ? { status: "reachable" }
    : { status: "unreachable", reason: reasons.join("; ") };
};

const readTail = async (filePath: string): Promise<string> => {
  const text = await Bun.file(filePath).text();
  return text.trim().slice(-FAILURE_TAIL_CHARS);
};

const runConnectCommand = async (command: string): Promise<void> => {
  // stderr goes to a file, not a pipe: a command that leaves a background
  // process holding an inherited pipe would never signal EOF.
  const stderrPath = path.join(
    tmpdir(),
    `stella-dev-public-law-connect-${String(process.pid)}.log`,
  );
  // A file target is written in place, not truncated: clear the last run's tail.
  await Bun.write(stderrPath, "");
  const subprocess = Bun.spawn([command], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: Bun.file(stderrPath),
    timeout: CONNECT_COMMAND_TIMEOUT_MS,
  });
  const exitCode = await subprocess.exited;
  if (exitCode !== 0) {
    const tail = await readTail(stderrPath);
    const exit =
      subprocess.signalCode === null
        ? `exit ${String(exitCode)}`
        : `${subprocess.signalCode}; the limit is ${String(CONNECT_COMMAND_TIMEOUT_MS / 1000)} s`;
    lastFailure = `Connect command failed (${exit})${tail ? `: ${tail}` : ""}`;
    return;
  }
  const probe = await probeCorpus();
  lastFailure =
    probe.status === "reachable"
      ? null
      : `Connect command succeeded, corpus still unreachable. ${probe.reason}`;
};

export const readPublicLawConnection =
  async (): Promise<PublicLawConnection> => {
    const config = readConfig();
    if (config.status === "unconfigured") {
      return config;
    }
    if (connectRun !== null) {
      return { status: "connecting" };
    }
    const probe = await probeCorpus();
    if (probe.status === "reachable") {
      lastFailure = null;
      return { status: "connected" };
    }
    return lastFailure === null
      ? { status: "disconnected", reason: probe.reason }
      : { status: "failed", message: lastFailure };
  };

export const startPublicLawConnection = (): PublicLawConnection => {
  const config = readConfig();
  if (config.status === "unconfigured") {
    return config;
  }
  connectRun ??= runConnectCommand(config.command)
    .catch((error: unknown) => {
      lastFailure = `Connect command could not run: ${errorMessage(error)}`;
    })
    .finally(() => {
      connectRun = null;
    });
  return { status: "connecting" };
};
