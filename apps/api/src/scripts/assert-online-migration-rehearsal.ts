import { panic } from "better-result";
import { readFileSync } from "node:fs";

import {
  assertOnlineRepairRehearsalCoverage,
  parseOnlineRepairRehearsalReport,
} from "../db/online-migration-rehearsal-guard";
import { ONLINE_MIGRATION_REPAIRS } from "../db/online-migrations";

const report = process.argv.at(2);
if (report === undefined || process.argv.length !== 3) {
  panic("Usage: assert-online-migration-rehearsal.ts <report>");
}

const records = parseOnlineRepairRehearsalReport(readFileSync(report, "utf-8"));

assertOnlineRepairRehearsalCoverage({
  records,
  repairs: ONLINE_MIGRATION_REPAIRS,
});
