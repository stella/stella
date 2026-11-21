import { panic } from "better-result";
import * as v from "valibot";

import type {
  OnlineRepair,
  OnlineRepairCompletion,
} from "./online-migration-connection";

const COMPLETIONS = {
  complete: "complete",
  incomplete: "incomplete",
  pending: "pending",
} as const satisfies Record<
  OnlineRepairCompletion["type"],
  OnlineRepairCompletion["type"]
>;

const onlineRepairRehearsalRecordSchema = v.variant("type", [
  v.strictObject({
    type: v.literal("checked"),
    name: v.pipe(v.string(), v.nonEmpty()),
    completion: v.picklist(Object.values(COMPLETIONS)),
  }),
  v.strictObject({
    type: v.literal("attempted"),
    name: v.pipe(v.string(), v.nonEmpty()),
  }),
]);

export type OnlineRepairRehearsalRecord = v.InferOutput<
  typeof onlineRepairRehearsalRecordSchema
>;

export const parseOnlineRepairRehearsalReport = (
  source: string,
): OnlineRepairRehearsalRecord[] => {
  if (source === "" || !source.endsWith("\n")) {
    return panic("Online repair rehearsal report is empty or truncated");
  }
  return source
    .slice(0, -1)
    .split("\n")
    .map((line) =>
      v.parse(onlineRepairRehearsalRecordSchema, JSON.parse(line)),
    );
};

export const parseOnlineRepairRehearsalArguments = (
  args: readonly string[],
): string | null => {
  if (args.length === 0) {
    return null;
  }
  const [flag, report] = args;
  if (
    args.length !== 2 ||
    flag !== "--rehearsal-online-repair-report" ||
    report === undefined ||
    report.trim() === "" ||
    report.startsWith("--") ||
    report.includes("\0")
  ) {
    return panic("Usage: migrate.ts [--rehearsal-online-repair-report <path>]");
  }
  return report;
};

export const assertOnlineRepairRehearsalCoverage = ({
  records,
  repairs,
}: {
  records: readonly OnlineRepairRehearsalRecord[];
  repairs: readonly OnlineRepair[];
}): void => {
  const expected = new Set(repairs.map(({ name }) => name));
  if (expected.size !== repairs.length) {
    panic("Online repair rehearsal registry contains duplicate names");
  }
  const checked = new Set<string>();
  let awaitingAttempt: string | null = null;
  for (const record of records) {
    if (!expected.has(record.name)) {
      panic(`Online repair rehearsal observed unknown repair ${record.name}`);
    }
    if (awaitingAttempt !== null) {
      if (record.type !== "attempted" || record.name !== awaitingAttempt) {
        panic(
          `Online repair rehearsal is missing attempt for ${awaitingAttempt}`,
        );
      }
      awaitingAttempt = null;
      continue;
    }
    switch (record.type) {
      case "checked":
        checked.add(record.name);
        if (record.completion !== "complete") {
          awaitingAttempt = record.name;
        }
        break;
      case "attempted":
        return panic(
          `Online repair rehearsal has an unexpected attempt for ${record.name}`,
        );
      default:
        record satisfies never;
        panic("Online repair rehearsal has an unexpected observation");
    }
  }
  if (awaitingAttempt !== null) {
    panic(`Online repair rehearsal is missing attempt for ${awaitingAttempt}`);
  }
  const missing = [...expected].filter((name) => !checked.has(name));
  if (missing.length > 0) {
    panic(
      `Online repair rehearsal did not check registered repairs: ${missing.join(", ")}`,
    );
  }
};
