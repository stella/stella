import { parseArgs } from "node:util";

import { runScriptWithErrorOutput } from "@stll/errors/script-error";

import { EU_SOFT_LAW_SOURCES } from "@/api/handlers/soft-law/adapters/registry";
import { SoftLawIngestionError } from "@/api/lib/legal-search/soft-law-types";

// No database connection or publisher request is opened without --apply.
if (import.meta.main) {
  await runScriptWithErrorOutput(async () => {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        source: { type: "string" },
        apply: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    const source = Object.values(EU_SOFT_LAW_SOURCES).find(
      ({ adapter }) => adapter.key === values.source,
    );
    if (!source) {
      throw new SoftLawIngestionError({
        message: `Use --source ${Object.keys(EU_SOFT_LAW_SOURCES).join(" | ")}; --apply starts one bounded ingestion run`,
      });
    }
    const authority = source.adapter.authority;
    if (!values.apply) {
      console.log(
        JSON.stringify({
          mode: "dry-run",
          source: authority,
          access: source.adapter.access,
          descriptor: source.descriptor,
          reuseNotice: source.reuseNotice,
        }),
      );
      return;
    }
    const { rootDb } = await import("@/api/db/root");
    const { assertDatabaseLoginPosture } =
      await import("@/api/lib/db/assert-database-login-posture");
    await assertDatabaseLoginPosture(rootDb);
    const { syncEuSoftLaw } = await import("@/api/handlers/soft-law/sync");
    const { getCaseLawIngestionDb } =
      await import("@/api/lib/case-law-ingestion-db");
    const result = await syncEuSoftLaw({
      authority,
      scopedDb: getCaseLawIngestionDb(),
      signal: AbortSignal.timeout(15 * 60 * 1000),
    });
    if (result.status === "failed") {
      throw new SoftLawIngestionError({
        message: "EU soft-law ingestion failed",
        cause: result.error,
      });
    }
    console.log(JSON.stringify({ source: authority, ...result }));
  });
}
