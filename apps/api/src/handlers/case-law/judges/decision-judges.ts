import { panic } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

import type { DecisionJudgeRole } from "@stll/api-contract/case-law-judges";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisionJudges,
  caseLawDecisions,
  caseLawJudges,
} from "@/api/db/schema";
import { judgeNameKey } from "@/api/handlers/case-law/judges/judge-name";
import type { SafeId } from "@/api/lib/branded-types";
import type { DecisionJudgeInput } from "@/api/lib/legal-search/ingestion-types";
import { logger } from "@/api/lib/observability/logger";

/**
 * The query surface each write needs, structurally: the ingestion pipeline
 * passes its transaction and the roster import its own handle, and neither
 * has to be the other.
 */
type DecisionJudgeWriter = Pick<Transaction, "delete" | "insert" | "select">;

type StatementRunner = {
  execute: (query: SQLWrapper) => PromiseLike<unknown>;
};

type ReplaceDecisionJudgesOptions = {
  decisionId: SafeId<"caseLawDecision">;
  judges: readonly DecisionJudgeInput[];
};

type DecisionCourt = {
  country: string;
  court: string;
};

type DecisionJudgeRow = typeof caseLawDecisionJudges.$inferInsert;

/** Drivers disagree: bun-sql returns the rows, pglite wraps them in `{ rows }`. */
const rowCount = (result: unknown): number => {
  if (Array.isArray(result)) {
    return result.length;
  }
  if (typeof result === "object" && result !== null) {
    const rows: unknown = Reflect.get(result, "rows");
    if (Array.isArray(rows)) {
      return rows.length;
    }
  }
  return panic("Judge relink returned no row set");
};

/**
 * The decision's rows, keyed and positioned.
 *
 * `(decision_id, role, name_key)` is the primary key, so one name printed
 * twice in a role is one row: the second mention says nothing the first did
 * not. Position is the order within the role, as printed.
 */
const decisionJudgeRows = (
  decisionId: SafeId<"caseLawDecision">,
  judges: readonly DecisionJudgeInput[],
): DecisionJudgeRow[] => {
  const rows = new Map<string, DecisionJudgeRow>();
  const nextPosition = new Map<DecisionJudgeRole, number>();

  for (const { role, nameAsPrinted } of judges) {
    const nameKey = judgeNameKey(nameAsPrinted);
    if (nameKey === "") {
      continue;
    }
    const identity = `${role}:${nameKey}`;
    if (rows.has(identity)) {
      continue;
    }
    const position = nextPosition.get(role) ?? 0;
    nextPosition.set(role, position + 1);
    rows.set(identity, {
      decisionId,
      judgeId: null,
      nameAsPrinted,
      nameKey,
      role,
      position,
    });
  }

  return [...rows.values()];
};

const readDecisionCourt = async (
  tx: DecisionJudgeWriter,
  decisionId: SafeId<"caseLawDecision">,
): Promise<DecisionCourt> => {
  const [decision] = await tx
    .select({
      country: caseLawDecisions.country,
      court: caseLawDecisions.court,
    })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.id, decisionId))
    .limit(1);

  return (
    decision ??
    panic(`Decision ${decisionId} has no row to take its judges' court from`)
  );
};

const rosterIdsByNameKey = async (
  tx: DecisionJudgeWriter,
  { country, court }: DecisionCourt,
  nameKeys: readonly string[],
): Promise<Map<string, SafeId<"caseLawJudge">>> => {
  const roster = await tx
    .select({ id: caseLawJudges.id, nameKey: caseLawJudges.nameKey })
    .from(caseLawJudges)
    .where(
      and(
        eq(caseLawJudges.country, country),
        eq(caseLawJudges.court, court),
        inArray(caseLawJudges.nameKey, [...nameKeys]),
      ),
    );

  return new Map(roster.map(({ id, nameKey }) => [nameKey, id]));
};

/**
 * Replace the judges a decision names, inside the caller's transaction.
 *
 * The decision states these names, so they are stored whether or not the
 * court's roster has been imported: an unmatched name keeps `judge_id` null
 * and is linked by {@link relinkUnmatchedDecisionJudges} once the roster
 * arrives. The miss is reported, never swallowed: a court whose names never
 * match is a parser or roster defect, and silence is what would hide it.
 */
export const replaceDecisionJudges = async (
  tx: DecisionJudgeWriter,
  { decisionId, judges }: ReplaceDecisionJudgesOptions,
): Promise<void> => {
  // audit: skip — public case-law data written by ingestion, not a user action
  await tx
    .delete(caseLawDecisionJudges)
    .where(eq(caseLawDecisionJudges.decisionId, decisionId));

  const rows = decisionJudgeRows(decisionId, judges);
  if (rows.length === 0) {
    return;
  }

  const decisionCourt = await readDecisionCourt(tx, decisionId);
  const rosterIds = await rosterIdsByNameKey(
    tx,
    decisionCourt,
    rows.map(({ nameKey }) => nameKey),
  );

  for (const row of rows) {
    const judgeId = rosterIds.get(row.nameKey);
    if (judgeId === undefined) {
      // `judgeKey`, not `nameKey`: the logger drops attribute keys that read
      // as free text (`name` among them) before they are shipped.
      logger.warn("case_law.judge_unmatched", {
        country: decisionCourt.country,
        court: decisionCourt.court,
        judgeKey: row.nameKey,
      });
      continue;
    }
    row.judgeId = judgeId;
  }

  await tx.insert(caseLawDecisionJudges).values(rows);
};

type RelinkUnmatchedDecisionJudgesOptions = DecisionCourt;

/**
 * Link the names a roster import has just made matchable.
 *
 * Runs after a roster import; the court is the one that was imported, and a
 * decision's court is the decision's own, so a name shared with another
 * court's judge stays unmatched.
 */
export const relinkUnmatchedDecisionJudges = async (
  db: StatementRunner,
  { country, court }: RelinkUnmatchedDecisionJudgesOptions,
): Promise<{ linked: number }> => {
  const linked = await db.execute(sql`
    UPDATE ${caseLawDecisionJudges} AS dj
    SET judge_id = j.id
    FROM ${caseLawJudges} AS j
    JOIN ${caseLawDecisions} AS d
      ON d.country = j.country AND d.court = j.court
    WHERE dj.decision_id = d.id
      AND dj.judge_id IS NULL
      AND dj.name_key = j.name_key
      AND j.country = ${country}
      AND j.court = ${court}
    RETURNING 1
  `);

  return { linked: rowCount(linked) };
};
