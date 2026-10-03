import { Result } from "better-result";
import { parseArgs } from "node:util";

import { env } from "@/api/env";

import { runSeedReport } from "./seed-usage-policies-runner";

const run = async () => {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { results: { type: "string" } },
    allowPositionals: false,
  });
  const resultsPath =
    values.results ??
    `/tmp/usage-policy-results-${Date.now()}-${process.pid}.jsonl`;
  const report = await runSeedReport({
    input: env.STELLA_USAGE_POLICY_SEEDS,
    resultsPath,
    openDb: async () => {
      const { openMaintenanceDb } = await import("@/api/lib/db/maintenance-db");
      return openMaintenanceDb({ readOnly: false });
    },
  });
  if (report.status === "complete") {
    console.log(
      `usage policies: seeded=${report.seeded} hidden=${report.rows.filter((row) => row.outcome === "hidden").length}`,
    );
  }
  console.log(
    `usage policy results: ${resultsPath}\n\`\`\`jsonl\n${report.lines}\n\`\`\``,
  );
  return report.status === "complete";
};

const result = await Result.tryPromise(run);
if (result.isErr() || !result.value) {
  process.stderr.write(
    "Usage policy seed failed; check configuration, results path and database access.\n",
  );
  process.exit(1);
}
process.exit(0);
