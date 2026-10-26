import { parseArgs } from "node:util";

import { runScriptWithErrorOutput } from "@stll/errors/script-error";

import {
  configureSoftLawAdapter,
  SOFT_LAW_ADMISSIONS,
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
        "admission-file": { type: "string" },
        apply: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    const source = Object.values(SOFT_LAW_ADMISSIONS).find(
      (entry) =>
        entry.state === "registered" && entry.adapter.key === values.source,
    );
    if (!source || source.state !== "registered") {
      throw new SoftLawIngestionError({
        message: `Use --source ${Object.values(SOFT_LAW_ADMISSIONS)
          .filter((entry) => entry.state === "registered")
          .map((entry) => entry.adapter.key)
          .join(" | ")}; --apply starts one bounded ingestion run`,
      });
    }
    const authority = source.adapter.authority;
    const configuration =
      values["admission-file"] === undefined
        ? { type: "default" as const }
        : { type: "admission-file" as const, path: values["admission-file"] };
    const configured = await configureSoftLawAdapter(
      source.adapter,
      configuration,
    );
    if (configured.isErr()) {
      throw configured.error;
    }
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
    const { syncSoftLaw } = await import("@/api/handlers/soft-law/sync");
    const session = await enterCaseLawMaintenanceLane();
    try {
      const result = await syncSoftLaw({
        authority,
        configuration,
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
