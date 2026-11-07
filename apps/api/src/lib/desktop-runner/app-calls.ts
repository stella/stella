import { and, asc, count, eq, isNull, or } from "drizzle-orm";

import { sha256Hex } from "@stll/sha256/bun";
import { stableStringify } from "@stll/stable-stringify";
import type { StableStringifyInput } from "@stll/stable-stringify";

import { desktopRunnerAppCalls, desktopRunnerRuns } from "@/api/db/schema";
import type { DesktopRunnerDb, RunOwner } from "@/api/lib/desktop-runner/store";

/**
 * The ledger of what stella's MCP server answered a local run for tools that
 * a chat app presents. The MCP server writes a row when it answers a run's
 * token; the chat turn reading the run pairs each call the desktop reported
 * with one row of the same run, tool and arguments, and shows the app from
 * the row. The desktop never supplies what the app shows.
 *
 * Pairing is by order among the rows with the same tool and arguments. A
 * desktop that reports two calls of the same tool with the same arguments in
 * the other order gets each call shown with the other's answer; both answers
 * are still ones the server gave this run for exactly those arguments.
 */

/** A run holds at most this many app calls; later calls show no app. */
export const MAX_APP_CALLS_PER_RUN = 16;

const toStableInput = (value: unknown): StableStringifyInput => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toStableInput);
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, toStableInput(child)]),
    );
  }
  return undefined;
};

/**
 * The identity of a call's arguments: the same object in any key order has
 * the same hash, so the server's copy and the harness's report compare.
 */
export const appCallArgumentsHash = (args: Record<string, unknown>): string =>
  sha256Hex(stableStringify(toStableInput(args)));

type RecordAppCallOptions = {
  owner: RunOwner;
  runId: string;
  toolName: string;
  argumentsHash: string;
  resourceUri: string;
  result: Record<string, unknown>;
};

const calls = desktopRunnerAppCalls;
const runs = desktopRunnerRuns;

const ownsRun = (owner: RunOwner, runId: string) =>
  and(
    eq(runs.runId, runId),
    eq(runs.userId, owner.userId),
    eq(runs.organizationId, owner.organizationId),
  );

/**
 * Record one answer the server gave the run. The row is written only for a
 * run of the token's own member and organization, and only while the run
 * holds fewer than `MAX_APP_CALLS_PER_RUN` answers. Calls of one run that
 * the server answers at the same moment can each pass that check, so a run
 * can end a few rows over the bound, never more than it had calls in
 * flight; the identity key orders them as the server wrote them.
 */
export const recordAppCall = async (
  db: Pick<DesktopRunnerDb, "select" | "insert">,
  {
    owner,
    runId,
    toolName,
    argumentsHash,
    resourceUri,
    result,
  }: RecordAppCallOptions,
): Promise<boolean> => {
  const held = (
    await db
      .select({ rows: count(calls.id) })
      .from(runs)
      .leftJoin(calls, eq(calls.runId, runs.runId))
      .where(ownsRun(owner, runId))
      .groupBy(runs.runId)
  ).at(0);
  if (held === undefined || held.rows >= MAX_APP_CALLS_PER_RUN) {
    return false;
  }
  // audit: skip - run bookkeeping; the MCP server audits the member's call
  await db
    .insert(calls)
    .values({ runId, toolName, argumentsHash, resourceUri, result });
  return true;
};

type PairAppCallOptions = {
  owner: RunOwner;
  runId: string;
  toolName: string;
  argumentsHash: string;
  /** The chat call the desktop reported, as the turn names it. */
  toolCallId: string;
};

export type PairedAppCall = {
  resourceUri: string;
  result: Record<string, unknown>;
};

const isResultObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const pairedRow = (
  row: { resourceUri: string; result: unknown } | undefined,
): PairedAppCall | null =>
  row === undefined || !isResultObject(row.result)
    ? null
    : { resourceUri: row.resourceUri, result: row.result };

/**
 * The server's answer for a call the desktop reported: the row already
 * paired with this call, or else the run's first unpaired row of the same
 * tool and arguments, now paired with it. A run of another member, or a
 * report the server never answered, pairs with nothing. The update holds
 * only while the row is free, so a reader that loses a race for it pairs
 * nothing rather than sharing it.
 */
export const pairAppCall = async (
  db: Pick<DesktopRunnerDb, "select" | "update">,
  { owner, runId, toolName, argumentsHash, toolCallId }: PairAppCallOptions,
): Promise<PairedAppCall | null> => {
  const candidates = await db
    .select({
      id: calls.id,
      resourceUri: calls.resourceUri,
      result: calls.result,
      pairedToolCallId: calls.pairedToolCallId,
    })
    .from(calls)
    .innerJoin(runs, eq(runs.runId, calls.runId))
    .where(
      and(
        ownsRun(owner, runId),
        eq(calls.runId, runId),
        eq(calls.toolName, toolName),
        eq(calls.argumentsHash, argumentsHash),
        or(
          eq(calls.pairedToolCallId, toolCallId),
          isNull(calls.pairedToolCallId),
        ),
      ),
    )
    .orderBy(asc(calls.id))
    .limit(MAX_APP_CALLS_PER_RUN);
  const held = candidates.find(
    ({ pairedToolCallId }) => pairedToolCallId === toolCallId,
  );
  if (held !== undefined) {
    return pairedRow(held);
  }
  const free = candidates.at(0);
  if (free === undefined) {
    return null;
  }
  // audit: skip - run bookkeeping; the MCP server audited the member's call
  const taken = await db
    .update(calls)
    .set({ pairedToolCallId: toolCallId })
    .where(and(eq(calls.id, free.id), isNull(calls.pairedToolCallId)))
    .returning({ resourceUri: calls.resourceUri, result: calls.result });
  return pairedRow(taken.at(0));
};
