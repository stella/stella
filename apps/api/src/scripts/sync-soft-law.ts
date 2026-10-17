import { parseArgs } from "node:util";

import { runScriptWithErrorOutput } from "@stll/errors/script-error";

import {
  SOFT_LAW_ADMISSIONS,
  isRegisteredSoftLawAuthority,
} from "@/api/handlers/soft-law/adapters/registry";
import { enterCaseLawMaintenanceLane } from "@/api/lib/case-law/maintenance-lane";
import { SoftLawIngestionError } from "@/api/lib/legal-search/soft-law-types";

// No database connection or publisher request is opened without --apply.
if (import.meta.main) {
  await runScriptWithErrorOutput(async () => {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        source: { type: "string" },
        apply: { type: "boolean", default: false },
        "admission-file": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });
    if (!values.source || !isRegisteredSoftLawAuthority(values.source)) {
      throw new SoftLawIngestionError({
        message:
          "Use --source with a registered soft-law authority; --apply starts one bounded ingestion run",
      });
    }
    const authority = values.source;
    const source = SOFT_LAW_ADMISSIONS[authority];
    const loaded = await source.loadAdapter(
      values["admission-file"] === undefined
        ? { type: "default" }
        : { type: "admission-file", path: values["admission-file"] },
    );
    if (loaded.status === "error") {
      throw loaded.error;
    }
    if (!values.apply) {
      console.log(
        JSON.stringify({
          mode: "dry-run",
          source: authority,
          access: loaded.value.access,
          descriptor: source.descriptor,
          reuseNotice: source.reuseNotice,
        }),
      );
      return;
    }
    const { syncSoftLaw } = await import("@/api/handlers/soft-law/sync");
    const session = await enterCaseLawMaintenanceLane();
    try {
      const result = await syncSoftLaw({
        adapter: loaded.value,
        scopedDb: session.ingestionDb,
        signal: AbortSignal.timeout(15 * 60 * 1000),
      });
      if (result.status === "failed") {
        throw new SoftLawIngestionError({
          message: "Soft-law ingestion failed",
          cause: result.error,
        });
      }
      console.log(JSON.stringify({ source: authority, ...result }));
    } finally {
      await session.release();
    }
  });
}
