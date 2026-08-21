import { Result } from "better-result";
import { and, asc, eq } from "drizzle-orm";

import {
  bilingualTranslationRows,
  bilingualTranslationRuns,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { BILINGUAL_LIMITS } from "@/api/lib/bilingual/contract";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description:
    "Read one bilingual translation run: status, progress, and per-row results with consistency warnings.",
  permissions: { workspace: ["read"] },
  access: "read",
  mcp: { type: "internal", reason: "document_processing" },
  params: workspaceParams({ runId: tSafeId("bilingualTranslationRun") }),
} satisfies HandlerConfig;

const readBilingualRun = createSafeHandler(
  config,
  async function* ({ params, safeDb, workspaceId }) {
    const runs = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: bilingualTranslationRuns.id,
            status: bilingualTranslationRuns.status,
            errorCode: bilingualTranslationRuns.errorCode,
            entityId: bilingualTranslationRuns.entityId,
            fileFieldId: bilingualTranslationRuns.fileFieldId,
            entityVersionId: bilingualTranslationRuns.entityVersionId,
            outputEntityVersionId:
              bilingualTranslationRuns.outputEntityVersionId,
            sourceLang: bilingualTranslationRuns.sourceLang,
            targetLang: bilingualTranslationRuns.targetLang,
            total: bilingualTranslationRuns.total,
            completed: bilingualTranslationRuns.completed,
            createdAt: bilingualTranslationRuns.createdAt,
            startedAt: bilingualTranslationRuns.startedAt,
            finishedAt: bilingualTranslationRuns.finishedAt,
          })
          .from(bilingualTranslationRuns)
          .where(
            and(
              eq(bilingualTranslationRuns.id, params.runId),
              eq(bilingualTranslationRuns.workspaceId, workspaceId),
            ),
          )
          .limit(1),
      ),
    );
    const run = runs.at(0);
    if (!run) {
      return Result.err(
        new HandlerError({ status: 404, message: "Run not found" }),
      );
    }

    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            rowId: bilingualTranslationRows.rowId,
            ordinal: bilingualTranslationRows.ordinal,
            kind: bilingualTranslationRows.kind,
            disposition: bilingualTranslationRows.disposition,
            status: bilingualTranslationRows.status,
            warnings: bilingualTranslationRows.warnings,
            sourceText: bilingualTranslationRows.sourceText,
            targetText: bilingualTranslationRows.targetText,
          })
          .from(bilingualTranslationRows)
          .where(eq(bilingualTranslationRows.runId, params.runId))
          .orderBy(asc(bilingualTranslationRows.ordinal))
          .limit(BILINGUAL_LIMITS.rowsMax),
      ),
    );

    return Result.ok({ run, rows });
  },
);

export default readBilingualRun;
