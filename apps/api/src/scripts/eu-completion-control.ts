import { panic, Result } from "better-result";
import { parseArgs } from "node:util";
import * as v from "valibot";

import { Temporal } from "@stll/time";

import { createEuCompletionStore } from "@/api/handlers/case-law/ingestion/eu-completion-store";
import type { CaseLawRootHandle } from "@/api/lib/case-law/maintenance-lane";
import { brandPersistedCaseLawSourceId } from "@/api/lib/safe-id-boundaries";

const attribution = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(128),
);
const source = v.pipe(
  v.string(),
  v.uuid(),
  v.transform(brandPersistedCaseLawSourceId),
);
const timestamp = v.pipe(
  v.string(),
  v.isoTimestamp(),
  v.transform((value) => new Date(value)),
  v.check(
    (value) => value.getTime() <= Temporal.Now.instant().epochMilliseconds,
    "Operator timestamps cannot be in the future",
  ),
);
const count = v.pipe(
  v.string(),
  v.regex(/^\d+$/u),
  v.transform(Number),
  v.integer(),
  v.minValue(0),
  v.maxValue(1_000_000),
);
const commandSchema = v.variant("command", [
  v.strictObject({
    command: v.literal("global"),
    state: v.picklist(["off", "on"]),
    who: attribution,
    when: timestamp,
  }),
  v.strictObject({
    command: v.literal("source"),
    source,
    state: v.picklist(["off", "on"]),
    who: attribution,
    when: timestamp,
  }),
  v.pipe(
    v.strictObject({
      command: v.literal("approve"),
      source,
      "parser-version": count,
      receipt: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
      evidence: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2048)),
      "supervised-by": attribution,
      "supervised-at": timestamp,
      who: attribution,
      when: timestamp,
      reviewed: count,
      accepted: count,
      "requires-review": count,
    }),
    v.check(
      (command) =>
        command.reviewed >= 1 &&
        command.accepted + command["requires-review"] === command.reviewed,
      "Reviewed counts must be a nonempty complete partition",
    ),
  ),
]);
const USAGE = `EU completion controls (no publisher requests):
  global --state off|on --who OPERATOR --when ISO_TIMESTAMP
  source --source UUID --state off|on --who OPERATOR --when ISO_TIMESTAMP
  approve --source UUID --parser-version N --receipt ID --evidence REFERENCE
    --supervised-by OPERATOR --supervised-at ISO_TIMESTAMP --who OPERATOR
    --when ISO_TIMESTAMP --reviewed N --accepted N --requires-review N
Approval needs a completed dry-run receipt for the same source and parser.
Reviewed counts must satisfy accepted + requires-review = reviewed >= 1.
Controls and approval are separate operations; approval enables no control.
`;

export const parseEuCompletionControlCommand = (args: readonly string[]) => {
  const parsed = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      source: { type: "string" },
      state: { type: "string" },
      who: { type: "string" },
      when: { type: "string" },
      "parser-version": { type: "string" },
      receipt: { type: "string" },
      evidence: { type: "string" },
      "supervised-by": { type: "string" },
      "supervised-at": { type: "string" },
      reviewed: { type: "string" },
      accepted: { type: "string" },
      "requires-review": { type: "string" },
    },
  });
  if (parsed.positionals.length !== 1) {
    return v.parse(commandSchema, {});
  }
  return v.parse(commandSchema, {
    command: parsed.positionals.at(0),
    ...parsed.values,
  });
};

type ControlStore = Pick<
  ReturnType<typeof createEuCompletionStore>,
  "setControl" | "approveSupervisedDryRun"
>;
const CONTROL_QUERY_TIMEOUT_MS = 5000;
const CONTROL_TIMEOUT_MS = 30_000;

// A control-plane write touches only the completion controls and approvals.
// It takes no maintenance door, so a stop never waits behind the tick it
// stops (the census exemption in maintenance-lane.test.ts).
const withOperatorStore = async (
  work: (store: ControlStore) => Promise<number>,
) => {
  const [{ withLongRunningConnection }, { runUnderCorpusSchemaLane }] =
    await Promise.all([
      import("@/api/db/long-running-connection"),
      import("@/api/db/corpus-schema-lane"),
    ]);
  const signal = AbortSignal.timeout(CONTROL_TIMEOUT_MS);
  return await withLongRunningConnection(
    {
      statementTimeout: CONTROL_QUERY_TIMEOUT_MS,
      lockTimeout: CONTROL_QUERY_TIMEOUT_MS,
      signal,
    },
    async ({ db }) => {
      const transaction: CaseLawRootHandle["transaction"] = async (fn) =>
        await runUnderCorpusSchemaLane({
          database: db,
          laneWaitMs: CONTROL_QUERY_TIMEOUT_MS,
          signal,
          work: fn,
        });
      return await work(
        createEuCompletionStore({
          db: {
            transaction,
            execute: async (query) =>
              await transaction(async (tx) => await tx.execute(query)),
          },
          now: () => Temporal.Now.instant().epochMilliseconds,
        }),
      );
    },
  );
};
const controlFailureMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown completion control failure";
};
type RunControlOptions = {
  args: readonly string[];
  createStore?: () => Promise<ControlStore>;
  write?: (record: unknown) => void;
  writeHelp?: (usage: string) => void;
};
export const runEuCompletionControl = async ({
  args,
  createStore,
  write = (record) => process.stdout.write(`${JSON.stringify(record)}\n`),
  writeHelp = (usage) => process.stdout.write(usage),
}: RunControlOptions) => {
  if (args.length === 1 && args.at(0) === "--help") {
    writeHelp(USAGE);
    return 0;
  }
  const attempted = await Result.tryPromise({
    try: async () => {
      const command = parseEuCompletionControlCommand(args);
      const runWithStore =
        createStore === undefined
          ? withOperatorStore
          : async (work: (store: ControlStore) => Promise<number>) =>
              await work(await createStore());
      return await runWithStore(async (store) => {
        switch (command.command) {
          case "global":
            await store.setControl({
              sourceId: null,
              state: command.state,
              changedBy: command.who,
              changedAt: command.when,
            });
            write({
              event: "case_law.eu_completion.control_changed",
              scope: "global",
              state: command.state,
              operator: command.who,
              at: command.when,
            });
            break;
          case "source":
            await store.setControl({
              sourceId: command.source,
              state: command.state,
              changedBy: command.who,
              changedAt: command.when,
            });
            write({
              event: "case_law.eu_completion.control_changed",
              scope: "source",
              sourceId: command.source,
              state: command.state,
              operator: command.who,
              at: command.when,
            });
            break;
          case "approve": {
            const approval = await store.approveSupervisedDryRun({
              sourceId: command.source,
              parserVersion: command["parser-version"],
              supervisedReceiptId: command.receipt,
              evidenceRef: command.evidence,
              supervisedBy: command["supervised-by"],
              supervisedAt: command["supervised-at"],
              approvedBy: command.who,
              approvedAt: command.when,
              reviewedCounts: {
                reviewed: command.reviewed,
                accepted: command.accepted,
                requiresReview: command["requires-review"],
              },
            });
            if (approval.isErr()) {
              write({
                event: "case_law.eu_completion.control_failed",
                code: approval.error.code,
                message: approval.error.message,
              });
              return 1;
            }
            const approved = approval.value;
            write({
              event: "case_law.eu_completion.supervised_approval",
              sourceId: approved.sourceId,
              parserVersion: approved.parserVersion,
              receiptId: approved.supervisedReceiptId,
              operator: approved.approvedBy,
              at: approved.approvedAt,
              reviewedCounts: approved.reviewedCounts,
            });
            break;
          }
          default:
            command satisfies never;
            return panic("Unexpected completion operator command");
        }
        return 0;
      });
    },
    catch: (error) => error,
  });
  if (attempted.isOk()) {
    return attempted.value;
  }
  write({
    event: "case_law.eu_completion.control_failed",
    message: controlFailureMessage(attempted.error),
  });
  return 1;
};

if (import.meta.main) {
  // The lane contract exits explicitly: the root pool stays open otherwise.
  process.exit(
    await runEuCompletionControl({
      args: process.argv.slice(2),
    }),
  );
}
