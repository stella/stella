import { Result } from "better-result";
import { parseArgs } from "node:util";

import { env } from "@/api/env";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";

import {
  runSeedReport,
  USAGE_POLICY_SEED_MODES,
} from "./seed-usage-policies-runner";

const run = async () => {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      results: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  const resultsPath =
    values.results ??
    `/tmp/usage-policy-results-${Date.now()}-${process.pid}.jsonl`;
  const report = await runSeedReport({
    input: env.STELLA_USAGE_POLICY_SEEDS,
    freeTier: isDeploymentFeatureEnabled("FEATURE_FREE_TIER") ? "on" : "off",
    resultsPath,
    mode: values["dry-run"]
      ? USAGE_POLICY_SEED_MODES.dryRun
      : USAGE_POLICY_SEED_MODES.apply,
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
