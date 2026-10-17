import { parseArgs } from "node:util";

import { runScriptWithErrorOutput } from "@stll/errors/script-error";

import { SOFT_LAW_AST_BUILDER_VERSION } from "@/api/lib/legal-search/soft-law-ast";
import { SoftLawAstReplayError } from "@/api/lib/legal-search/soft-law-ast-replay";
import {
  brandPersistedSoftLawSourceId,
  brandPersistedSoftLawDocumentVersionId,
} from "@/api/lib/safe-id-boundaries";

// One bounded page per invocation; successful version stamps are the durable repair checkpoint.
if (import.meta.main) {
  await runScriptWithErrorOutput(async () => {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        source: { type: "string" },
        after: { type: "string" },
        apply: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (!values.source) {
      throw new SoftLawAstReplayError({
        message:
          "Use --source <source id>; --apply rebuilds one bounded page from retained originals",
      });
    }
    const sourceId = brandPersistedSoftLawSourceId(values.source);
    const after = values.after
      ? brandPersistedSoftLawDocumentVersionId(values.after)
      : null;
    if (!values.apply) {
      console.log(
        JSON.stringify({
          mode: "dry-run",
          sourceId,
          after,
          astBuilderVersion: SOFT_LAW_AST_BUILDER_VERSION,
        }),
      );
      return;
    }
    const { enterCaseLawMaintenanceLane } =
      await import("@/api/lib/case-law/maintenance-lane");
    const { replaySoftLawAstBatch } =
      await import("@/api/lib/legal-search/soft-law-ast-replay");
    const session = await enterCaseLawMaintenanceLane();
    try {
      const outcome = await replaySoftLawAstBatch({
        scopedDb: session.ingestionDb,
        sourceId,
        after,
        signal: AbortSignal.timeout(15 * 60 * 1000),
      });
      if (outcome.status === "error") {
        throw outcome.error;
      }
      console.log(JSON.stringify({ sourceId, ...outcome.value }));
    } finally {
      await session.release();
    }
  });
}
