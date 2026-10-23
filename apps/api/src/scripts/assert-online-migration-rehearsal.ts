import { panic } from "better-result";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import { assertOnlineRepairRehearsalCoverage } from "../db/online-migration-rehearsal-guard";
import { ONLINE_MIGRATION_REPAIRS } from "../db/online-migrations";

const recordSchema = v.object({
  name: v.string(),
  precondition: v.picklist(["empty", "non-empty"]),
});

const report = process.argv.at(2);
if (report === undefined) {
  panic("Usage: assert-online-migration-rehearsal.ts <report>");
}

const records = readFileSync(report, "utf-8")
  .split("\n")
  .filter(Boolean)
  .map((line) => v.parse(recordSchema, JSON.parse(line)));

// Exceptions are temporary, reviewed debts. Keep this map empty unless a
// repair cannot safely be given representative rehearsal input.
const ALLOWLIST = {} as const satisfies Readonly<Record<string, string>>;

assertOnlineRepairRehearsalCoverage({
  allowlist: ALLOWLIST,
  records,
  repairs: ONLINE_MIGRATION_REPAIRS,
});
