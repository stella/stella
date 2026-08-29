/**
 * Prepare a bilingual translation: read the rows of a bilingual document,
 * decide what each row needs (translate, keep, inline) with rule prefilters
 * plus one model pass over the manifest, and propose a glossary for the
 * defined terms. The reviewer edits both before starting the run.
 */

import { Result } from "better-result";

import { readBilingualDocx } from "@stll/folio-core/server";

import { prepareBilingualTranslationBodySchema } from "@/api/handlers/bilingual-translations/schemas";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { decideDispositions, proposeGlossary } from "@/api/lib/bilingual/ai";
import type { BilingualAIDocumentContext } from "@/api/lib/bilingual/ai";
import { BILINGUAL_LIMITS } from "@/api/lib/bilingual/contract";
import {
  detectGlossaryCandidates,
  flattenBilingualRows,
} from "@/api/lib/bilingual/rows";
import { workspaceParams } from "@/api/lib/custom-schema";
import { loadEntityVersionDocxBuffer } from "@/api/lib/entity-versions/load-entity-version-docx-buffer";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const PREPARE_TIMEOUT_MS = 150_000;

const config = {
  description:
    "Read the rows of a bilingual (two-column) document and propose, for review, what to do with each row and which glossary renderings to use.",
  permissions: { entity: ["create"] },
  access: "write",
  mcp: { type: "internal", reason: "document_processing" },
  params: workspaceParams({}),
  body: prepareBilingualTranslationBodySchema,
  requiresUsage: { actionType: "doc_review", modelRole: "chat" },
} satisfies HandlerConfig;

const prepareBilingualTranslation = createSafeHandler(
  config,
  async function* ({
    body,
    orgAIConfig,
    promptCachingEnabled,
    request,
    safeDb,
    session,
    user,
    workspaceId,
  }) {
    if (body.sourceLang.toLowerCase() === body.targetLang.toLowerCase()) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Source and target language must differ",
        }),
      );
    }

    const loaded = yield* Result.await(
      loadEntityVersionDocxBuffer({
        safeDb,
        organizationId: session.activeOrganizationId,
        workspaceId,
        entityId: body.entityId,
        fileFieldId: body.fieldId,
      }),
    );

    const manifest = await Result.tryPromise({
      try: async () => await readBilingualDocx(loaded.buffer),
      catch: (cause) => cause,
    });
    if (Result.isError(manifest)) {
      captureError(manifest.error, { source: "bilingual-prepare" });
      return Result.err(
        new HandlerError({
          status: 422,
          message: "The document could not be read",
        }),
      );
    }
    const { units, dropped } = flattenBilingualRows(manifest.value);
    if (units.length === 0) {
      return Result.err(
        new HandlerError({
          status: 422,
          message:
            "This document has no bilingual table. Create a bilingual version first.",
        }),
      );
    }
    if (units.length > BILINGUAL_LIMITS.rowsMax) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: `The document has ${units.length} rows; at most ${BILINGUAL_LIMITS.rowsMax} can be translated in one run.`,
        }),
      );
    }

    const organizationId = session.activeOrganizationId;
    const context: BilingualAIDocumentContext = {
      organizationId,
      workspaceId,
      orgAIConfig,
      promptCachingEnabled,
      abortSignal: AbortSignal.any([
        request.signal,
        AbortSignal.timeout(PREPARE_TIMEOUT_MS),
      ]),
      scopeKey: loaded.entityVersionId,
      sourceDocument: units,
      usageMetering: {
        actionType: "doc_review",
        organizationId,
        safeDb,
        serviceTier: "standard",
        userId: user.id,
        workspaceId,
      },
    };
    const languages = {
      sourceLang: body.sourceLang,
      targetLang: body.targetLang,
    };
    const texts = units.map((unit) => unit.sourceText);

    const prepared = await Result.tryPromise({
      try: async () => {
        const [rows, glossary] = await Promise.all([
          decideDispositions(units, languages, context),
          proposeGlossary(
            detectGlossaryCandidates(texts),
            texts,
            languages,
            context,
          ),
        ]);
        return { rows, glossary };
      },
      catch: (cause) => cause,
    });
    if (Result.isError(prepared)) {
      captureError(prepared.error, { source: "bilingual-prepare" });
      return Result.err(
        new HandlerError({
          status: 502,
          message: "The translation could not be prepared. Try again.",
        }),
      );
    }

    return Result.ok({
      entityVersionId: loaded.entityVersionId,
      rows: prepared.value.rows,
      glossary: prepared.value.glossary,
      droppedRows: dropped,
    });
  },
);

export default prepareBilingualTranslation;
