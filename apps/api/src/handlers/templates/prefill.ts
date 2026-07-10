import { Result } from "better-result";
import { and, eq, inArray, ne } from "drizzle-orm";
import { t } from "elysia";
import * as v from "valibot";

import { entities, extractedContent, workspaces } from "@/api/db/schema";
import { discoverTemplate } from "@/api/handlers/docx/discover-template";
import {
  mergeManifestWithDiscovery,
  readManifest,
} from "@/api/handlers/docx/template-manifest";
import {
  buildPrefillTargets,
  mapPrefillResults,
  renderPrefillTargets,
} from "@/api/handlers/templates/prefill-fields";
import type {
  PrefillSuggestion,
  PrefillTarget,
} from "@/api/handlers/templates/prefill-fields";
import { resolveCaching, type OrgAIConfig } from "@/api/lib/ai-config";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { decryptContent } from "@/api/lib/content-encryption";
import { tSafeId } from "@/api/lib/custom-schema";
import { formatDateInTimeZone } from "@/api/lib/date-format";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";
import { getS3 } from "@/api/lib/s3";
import { parsePickedEntityIdsJson } from "@/api/lib/safe-id-boundaries";
import { extractFileText } from "@/api/lib/search/extract-content";
import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";
import { requireTanStackAIAvailableForRole } from "@/api/lib/tanstack-ai-models";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";

const MAX_PASTED_TEXT_CHARS = 100_000;
const MAX_PICKED_ENTITIES = 5;
const MAX_CHARS_PER_SOURCE = 30_000;
const MAX_TOTAL_SOURCE_CHARS = 90_000;
const PREFILL_TIMEOUT_MS = 60_000;

const prefillParamsSchema = t.Object({
  templateId: tSafeId("template"),
});

const prefillBodySchema = t.Object({
  /** One uploaded source document (DOCX or PDF); the server extracts the
   *  text — clients never extract anything. */
  file: t.Optional(t.File({ maxSize: FILE_SIZE_LIMITS.document })),
  /** Pasted source text. */
  text: t.Optional(t.String({ maxLength: MAX_PASTED_TEXT_CHARS })),
  /** JSON-encoded array of entity ids whose stored extracted text should be
   *  used as sources (documents picked from a matter). String-encoded
   *  because the body is multipart when a file is attached. */
  entityIds: t.Optional(t.String({ maxLength: 2000 })),
  /** Caller's IANA time zone, used to anchor "today" in the prompt to the
   *  user's calendar day rather than the server's UTC day. */
  timezone: t.Optional(t.String({ maxLength: 64 })),
});

// strictObject + nullable-required members: OpenAI strict structured output
// rejects plain objects and optional properties.
const prefillOutputSchema = v.strictObject({
  fields: v.array(
    v.strictObject({
      id: v.string(),
      value: v.nullable(v.string()),
      sourceSnippet: v.nullable(v.string()),
    }),
  ),
});

const SYSTEM_PROMPT =
  "You prefill a legal document template from source material. For each " +
  "listed field, find its value in the sources. Copy values verbatim " +
  "wherever possible and never invent or guess a value that the sources do " +
  "not support; return null for fields the sources do not answer. " +
  "sourceSnippet is a short exact quote from the source that supports the " +
  "value (null when the value is null). Follow each field's format hint.";

const buildPrompt = (
  targets: readonly PrefillTarget[],
  sources: readonly PrefillSource[],
): string => {
  const sourceBlocks = sources
    .map((source) => `--- Source: ${source.label} ---\n${source.text}`)
    .join("\n\n");
  return `Fields to prefill (answer by id):
${renderPrefillTargets(targets)}

Sources:
${sourceBlocks}`;
};

type PrefillSource = { label: string; text: string };

/** Cap each source and the combined total so a pathological document cannot
 *  blow up the prompt; later sources get whatever budget remains. */
const boundSources = (sources: PrefillSource[]): PrefillSource[] => {
  const bounded: PrefillSource[] = [];
  let used = 0;
  for (const source of sources) {
    const remaining = MAX_TOTAL_SOURCE_CHARS - used;
    if (remaining <= 0) {
      break;
    }
    const text = source.text
      .trim()
      .slice(0, Math.min(MAX_CHARS_PER_SOURCE, remaining));
    if (text === "") {
      continue;
    }
    bounded.push({ label: source.label, text });
    used += text.length;
  }
  return bounded;
};

const extractFieldValues = async ({
  targets,
  sources,
  orgAIConfig,
  organizationId,
  aiAnalytics,
  timezone,
}: {
  targets: readonly PrefillTarget[];
  sources: readonly PrefillSource[];
  orgAIConfig: OrgAIConfig | null;
  organizationId: SafeId<"organization">;
  aiAnalytics: ReturnType<typeof createTanStackAIAnalyticsCallbacks>;
  timezone: string;
}): Promise<PrefillSuggestion[]> => {
  const { fields } = await generateTanStackObjectForRole({
    role: "fast",
    orgAIConfig,
    organizationId,
    analytics: aiAnalytics,
    caching: resolveCaching({
      promptCachingEnabled: false,
      role: "fast",
      scopeKey: organizationId,
    }),
    // Anchor relative dates in the sources ("as of today", deadlines) to the
    // user's calendar day (not UTC), so "today" near midnight resolves to the
    // date the user is actually on.
    system: `${SYSTEM_PROMPT}\nToday is ${formatDateInTimeZone({ timezone })}.`,
    prompt: buildPrompt(targets, sources),
    outputSchema: prefillOutputSchema,
    abortSignal: AbortSignal.timeout(PREFILL_TIMEOUT_MS),
    serviceTier: "standard",
  });
  return mapPrefillResults(targets, fields);
};

const config = {
  permissions: { template: ["use"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  params: prefillParamsSchema,
  body: prefillBodySchema,
  requiresUsage: { actionType: "chat", modelRole: "fast" },
} satisfies HandlerConfig;

/**
 * AI prefill for the template fill form: extract per-field values (plus the
 * supporting source snippet) from pasted text, one uploaded DOCX/PDF, and/or
 * documents already stored in matters the caller can access. Fields are
 * referenced by simple mapped ids in the model conversation; the response
 * maps them back to field paths. Nothing is filled server-side — the client
 * shows the proposals for review.
 */
const prefillTemplate = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, body, orgAIConfig, user }) {
    const organizationId = session.activeOrganizationId;

    yield* requireTanStackAIAvailableForRole({
      orgConfig: orgAIConfig,
      role: "fast",
    });

    const template = yield* Result.await(
      safeDb((tx) =>
        tx.query.templates.findFirst({
          where: {
            id: { eq: params.templateId },
            organizationId: { eq: organizationId },
          },
          columns: { s3Key: true },
        }),
      ),
    );
    if (!template) {
      return Result.err(
        new HandlerError({ status: 404, message: "Template not found" }),
      );
    }

    const sources: PrefillSource[] = [];

    if (body.text !== undefined && body.text.trim() !== "") {
      sources.push({ label: "Pasted text", text: body.text });
    }

    if (body.file !== undefined) {
      const file = body.file;
      if (file.type !== DOCX_MIME_TYPE && file.type !== PDF_MIME_TYPE) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Source file must be a DOCX or PDF document.",
          }),
        );
      }
      const text = yield* Result.await(
        Result.tryPromise({
          try: async () =>
            await extractFileText(await file.arrayBuffer(), file.type, {
              source: "template-prefill",
            }),
          catch: (cause) =>
            new HandlerError({
              status: 500,
              message: "Failed to read the source document",
              cause,
            }),
        }),
      );
      if (text === null || text.trim() === "") {
        return Result.err(
          new HandlerError({
            status: 422,
            message: "No text could be extracted from the source document.",
          }),
        );
      }
      sources.push({ label: file.name, text });
    }

    if (body.entityIds !== undefined) {
      const entityIds = parsePickedEntityIdsJson(
        body.entityIds,
        MAX_PICKED_ENTITIES,
      );
      if (entityIds === null) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: `'entityIds' must be a JSON array of at most ${String(MAX_PICKED_ENTITIES)} entity ids.`,
          }),
        );
      }

      if (entityIds.length > 0) {
        // Stored extracted text (the search pipeline's output), scoped to the
        // caller's organization and accessible workspaces — the same gate the
        // chat document tools apply.
        const contentRows = yield* Result.await(
          safeDb((tx) =>
            tx
              .select({
                ciphertext: extractedContent.ciphertext,
                iv: extractedContent.iv,
                name: entities.name,
              })
              .from(extractedContent)
              .innerJoin(
                entities,
                and(
                  eq(entities.id, extractedContent.entityId),
                  eq(entities.workspaceId, extractedContent.workspaceId),
                ),
              )
              .innerJoin(
                workspaces,
                eq(workspaces.id, extractedContent.workspaceId),
              )
              .where(
                and(
                  inArray(extractedContent.entityId, entityIds),
                  eq(extractedContent.organizationId, organizationId),
                  ne(workspaces.status, "deleting"),
                ),
              )
              // One extractedContent row per entity, and entityIds is capped at
              // MAX_PICKED_ENTITIES above, so the result set stays bounded.
              .limit(MAX_PICKED_ENTITIES),
          ),
        );

        const decrypted = yield* Result.await(
          Result.tryPromise({
            try: async () =>
              await Promise.all(
                contentRows.map(async (row) => ({
                  label: row.name,
                  text: await decryptContent(
                    organizationId,
                    row.ciphertext,
                    row.iv,
                  ),
                })),
              ),
            catch: (cause) =>
              new HandlerError({
                status: 500,
                message: "Failed to read the selected documents",
                cause,
              }),
          }),
        );
        sources.push(...decrypted);
      }
    }

    const boundedSources = boundSources(sources);
    if (boundedSources.length === 0) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Provide at least one source: text, a file, or documents.",
        }),
      );
    }

    // The template's fillable shape, merged from the embedded manifest and
    // marker discovery — the same field set the fill form renders.
    const targets = yield* Result.await(
      Result.tryPromise({
        try: async () => {
          const buffer = Buffer.from(
            await getS3().file(template.s3Key).arrayBuffer(),
          );
          const [discovered, manifest] = await Promise.all([
            discoverTemplate(buffer),
            readManifest(buffer),
          ]);
          return buildPrefillTargets(
            mergeManifestWithDiscovery(manifest, discovered),
          );
        },
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Failed to read the template",
            cause,
          }),
      }),
    );

    if (targets.length === 0) {
      return Result.ok({ fields: [] });
    }

    const aiAnalytics = createTanStackAIAnalyticsCallbacks({
      usageMetering: {
        actionType: "chat",
        organizationId,
        safeDb,
        serviceTier: "standard",
        userId: user.id,
        workspaceId: null,
      },
      feature: "templates.prefill",
      modelRole: "fast",
      orgAIConfig,
      properties: { organization_id: organizationId },
      traceId: Bun.randomUUIDv7(),
    });

    const fields = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await extractFieldValues({
            targets,
            sources: boundedSources,
            orgAIConfig,
            organizationId,
            aiAnalytics,
            timezone: body.timezone ?? "UTC",
          }),
        catch: (cause) => {
          aiAnalytics.captureError(cause);
          return new HandlerError({
            status: 500,
            message: "Failed to extract values from the sources",
            cause,
          });
        },
      }),
    );

    return Result.ok({ fields });
  },
);

export default prefillTemplate;
