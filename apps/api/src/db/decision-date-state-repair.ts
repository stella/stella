import { Result } from "better-result";

import { decisionDateStateBackfillSql } from "@/api/lib/db/transitions";
import { isRecord } from "@/api/lib/type-guards";

import {
  setColumnDefaultAndNotNull,
  validateOnlineConstraints,
} from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

const TABLE_NAME = "case_law_decisions";
const REPAIR_NAME = "decision-date-state";
const BATCH_SIZE = 500;

const CONSTRAINTS = [
  "case_law_decisions_decision_date_state_values",
  "case_law_decisions_decision_date_state_consistent",
].map((constraintName) => ({ tableName: TABLE_NAME, constraintName }));

/** Classify legacy rows in short, replay-safe transactions before cutover. */
export const DECISION_DATE_STATE_REPAIR: OnlineRepair = {
  name: REPAIR_NAME,
  readCompletion: async (connection) => {
    const row = (
      await connection.query(`
        SELECT attnotnull AS complete
          FROM pg_attribute
         WHERE attrelid = 'public.case_law_decisions'::regclass
           AND attname = 'decision_date_state'
      `)
    ).at(0);
    return isRecord(row) && row["complete"] === true
      ? { type: "complete" }
      : {
          type: "pending",
          reason: "legacy decision-date rows remain unclassified",
          cursor: null,
          holdUntil: null,
          heldSince: null,
        };
  },
  repair: async (connection, tables) => {
    for (;;) {
      await connection.execute("BEGIN");
      const batch = await Result.tryPromise({
        try: async () => {
          await connection.execute("SET LOCAL lock_timeout = '1s'");
          await connection.execute("SET LOCAL statement_timeout = '1min'");
          const rows = await connection.query(decisionDateStateBackfillSql, [
            BATCH_SIZE,
          ]);
          await connection.execute("COMMIT");
          return rows.length;
        },
        catch: (cause: unknown) => cause,
      });
      if (batch.isErr()) {
        await connection.execute("ROLLBACK");
        throw batch.error;
      }
      if (batch.value === 0) {
        break;
      }
    }

    const validated = await validateOnlineConstraints({
      connection,
      tables,
      constraints: CONSTRAINTS,
    });
    if (validated.type !== "complete") {
      return validated;
    }
    return await tables.run({
      target: { tableName: TABLE_NAME, name: REPAIR_NAME },
      kind: "index_build",
      work: async (session) => {
        await session.run(
          setColumnDefaultAndNotNull({
            tableName: TABLE_NAME,
            columnName: "decision_date_state",
            defaultSql: "'undated'",
          }),
        );
      },
    });
  },
};
