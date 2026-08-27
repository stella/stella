import { Result } from "better-result";
import { and, eq, gt, lt, or } from "drizzle-orm";
import { t } from "elysia";
import * as v from "valibot";

import { contactExtractionUploads } from "@/api/db/schema";
import { contactExtractionUploadKey } from "@/api/handlers/contacts/contact-extraction-upload";
import { resolveCaching } from "@/api/lib/ai-config";
import { captureError } from "@/api/lib/analytics/capture";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { getS3 } from "@/api/lib/s3";
import { headObject, readTenantS3ArrayBuffer } from "@/api/lib/s3-presign";
import {
  extractFileText,
  resolveExtractionMimeType,
} from "@/api/lib/search/extract-content";
import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";
import { requireTanStackAIAvailableForRole } from "@/api/lib/tanstack-ai-models";
import { sha256Base64ToHex } from "@/api/lib/uploads/runtime";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const MAX_SOURCE_CHARS = 30_000;
const EXTRACT_TIMEOUT_MS = 60_000;
const PROCESSING_LEASE_MS = 3 * 60 * 1000;

const extractProcuracaoBodySchema = t.Object({
  uploadId: tSafeId("contactExtractionUpload"),
});

// strictObject + nullable-required members: OpenAI strict structured output
// rejects plain objects and optional properties (see templates/prefill.ts).
const outorganteCandidateSchema = v.strictObject({
  nome: v.nullable(v.string()),
  taxId: v.nullable(v.string()),
  rg: v.nullable(v.string()),
  nacionalidade: v.nullable(v.string()),
  estadoCivil: v.nullable(v.string()),
  uniaoEstavel: v.nullable(v.string()),
  profissao: v.nullable(v.string()),
  email: v.nullable(v.string()),
  endereco: v.nullable(v.string()),
  contactType: v.nullable(v.picklist(["person", "organization"])),
});

const extractProcuracaoOutputSchema = v.strictObject({
  outorgantes: v.array(outorganteCandidateSchema),
});

type ProcuracaoExtraction = v.InferOutput<
  typeof extractProcuracaoOutputSchema
> & { truncated: boolean };

const SYSTEM_PROMPT = `You extract the OUTORGANTE(S) — the person or entity granting power of attorney — from a Brazilian "procuração" (power of attorney) document. Never extract the OUTORGADO (the lawyer/attorney receiving the power) as an outorgante, even when their qualification (OAB number, address) appears alongside the outorgante's.

Copy every value verbatim from the document; never invent, guess, complete, or normalize a value the document does not state (do not expand abbreviations, do not infer a marital status from context, do not compute a CPF check digit). Return null for any field the document does not state for that person.

A document may name more than one outorgante — for example spouses granting power together, or several co-owners. Return one entry per outorgante, including every one you find.

When an outorgante is a minor represented or assisted by a parent or legal guardian, return the minor as their own entry — using the minor's own name, document numbers, and qualification — and do not also return the parent/guardian as a second entry, unless that parent or guardian is independently named as a separate, additional outorgante in their own right.

When the outorgante is a pessoa jurídica (company) represented by an individual (e.g. "outorgante: [empresa], neste ato representada por seu sócio administrador [nome], CPF..."), return the company itself as the outorgante entry (nome = company name, taxId = CNPJ, contactType = "organization"); do not create a second entry for the representing individual.

If the uploaded document is not a procuração, or you cannot identify any outorgante in it, return an empty outorgantes array — do not guess or fabricate an entry.

Field notes:
- taxId: CPF (11 digits) for a person, CNPJ (14 digits) for a company. Copy the digits/punctuation as written; do not reformat.
- rg: the RG/Carteira de Identidade number, however it is labeled ("RG", "Carteira de Identidade", "Carteira de Identidade Profissional", etc.).
- estadoCivil, profissao, nacionalidade, uniaoEstavel: only set when the document states them for that specific outorgante; leave null otherwise.
- contactType: "person" for an individual outorgante, "organization" for a company outorgante.`;

const buildPrompt = (documentText: string): string =>
  `Document (procuração):\n---\n${documentText}\n---`;

const config = {
  permissions: { contact: ["create"] },
  mcp: { type: "internal", reason: "upload_mechanics" },
  body: extractProcuracaoBodySchema,
  requiresUsage: { actionType: "chat", modelRole: "fast" },
} satisfies HandlerConfig;

/**
 * AI extraction for the "Extrair de procuração" contact-intake flow: read
 * one uploaded DOCX power-of-attorney, identify every outorgante (grantor)
 * it names, and return their legal qualification for client-side review.
 * Nothing is written to the database — the client shows the candidates for
 * review and bulk-creates via the existing contacts import endpoint.
 */
const extractProcuracao = createSafeRootHandler(
  config,
  async function* ({
    session,
    body,
    orgAIConfig,
    orgAIConfigStatus,
    user,
    safeDb,
  }) {
    const organizationId = session.activeOrganizationId;

    yield* requireTanStackAIAvailableForRole({
      configStatus: orgAIConfigStatus,
      orgConfig: orgAIConfig,
      role: "fast",
    });

    const claimToken = Bun.randomUUIDv7();
    const processingStartedAt = new Date();
    const upload = yield* Result.await(
      safeDb(async (tx) => {
        // audit: skip — this row is an ephemeral upload-processing lease
        const [claimed] = await tx
          .update(contactExtractionUploads)
          .set({
            status: "processing",
            claimToken,
            processingStartedAt,
          })
          .where(
            and(
              eq(contactExtractionUploads.id, body.uploadId),
              eq(contactExtractionUploads.organizationId, organizationId),
              eq(contactExtractionUploads.userId, user.id),
              gt(contactExtractionUploads.expiresAt, new Date()),
              or(
                eq(contactExtractionUploads.status, "pending"),
                and(
                  eq(contactExtractionUploads.status, "processing"),
                  lt(
                    contactExtractionUploads.processingStartedAt,
                    new Date(Date.now() - PROCESSING_LEASE_MS),
                  ),
                ),
              ),
            ),
          )
          .returning();
        return claimed ?? null;
      }),
    );
    if (!upload) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Extraction upload was not found or has expired",
        }),
      );
    }

    const key = contactExtractionUploadKey({
      organizationId,
      uploadId: upload.id,
    });
    const extractionResult = await (async (): Promise<
      Result<ProcuracaoExtraction, HandlerError>
    > => {
      const mimeType = resolveExtractionMimeType({
        fileName: upload.declaredName,
        mimeType: upload.declaredMime,
      });
      if (mimeType !== DOCX_MIME_TYPE) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "The source file must be a DOCX document.",
          }),
        );
      }

      const objectHead = await headObject(key);
      if (Result.isError(objectHead)) {
        return Result.err(
          new HandlerError({
            status: 422,
            message: "The source upload is incomplete",
            cause: objectHead.error,
          }),
        );
      }
      if (
        objectHead.value.contentLength !== upload.declaredSize ||
        objectHead.value.checksumSHA256 === null ||
        sha256Base64ToHex(objectHead.value.checksumSHA256) !==
          upload.declaredSha256
      ) {
        return Result.err(
          new HandlerError({
            status: 422,
            message: "The source upload failed its integrity check",
          }),
        );
      }

      const fileBufferResult = await Result.tryPromise({
        try: async () =>
          await readTenantS3ArrayBuffer({
            key,
            scope: { organizationId, workspaceId: null },
            signal: AbortSignal.timeout(30_000),
          }),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Failed to read the source upload",
            cause,
          }),
      });
      if (Result.isError(fileBufferResult)) {
        return fileBufferResult;
      }

      const textResult = await Result.tryPromise({
        try: async () =>
          await extractFileText(fileBufferResult.value, mimeType, {
            source: "contacts-extract-procuracao",
          }),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Failed to read the source document",
            cause,
          }),
      });
      if (Result.isError(textResult)) {
        return textResult;
      }

      const text = textResult.value;
      if (text === null || text.trim() === "") {
        return Result.err(
          new HandlerError({
            status: 422,
            message: "No text could be extracted from the source document.",
          }),
        );
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
        feature: "contacts.extractProcuracao",
        modelRole: "fast",
        orgAIConfig,
        properties: { organization_id: organizationId },
        traceId: Bun.randomUUIDv7(),
      });

      const normalizedText = text.trim();
      const truncated = normalizedText.length > MAX_SOURCE_CHARS;
      const generated = await Result.tryPromise({
        try: async () =>
          await generateTanStackObjectForRole({
            role: "fast",
            orgAIConfig,
            organizationId,
            tenantWorkspaceIds: [],
            analytics: aiAnalytics,
            caching: resolveCaching({
              promptCachingEnabled: false,
              role: "fast",
              scopeKey: organizationId,
            }),
            system: SYSTEM_PROMPT,
            prompt: buildPrompt(normalizedText.slice(0, MAX_SOURCE_CHARS)),
            outputSchema: extractProcuracaoOutputSchema,
            abortSignal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
            serviceTier: "standard",
          }),
        catch: (cause) => {
          aiAnalytics.captureError(cause);
          return new HandlerError({
            status: 500,
            message: "Failed to extract contacts from the document.",
            cause,
          });
        },
      });
      if (Result.isError(generated)) {
        return generated;
      }

      return Result.ok({ ...generated.value, truncated });
    })();

    if (Result.isError(extractionResult)) {
      yield* Result.await(
        safeDb(async (tx) => {
          // audit: skip — releasing ephemeral upload-processing coordination
          await tx
            .update(contactExtractionUploads)
            .set({
              status: "pending",
              claimToken: null,
              processingStartedAt: null,
            })
            .where(
              and(
                eq(contactExtractionUploads.id, upload.id),
                eq(contactExtractionUploads.organizationId, organizationId),
                eq(contactExtractionUploads.userId, user.id),
                eq(contactExtractionUploads.status, "processing"),
                eq(contactExtractionUploads.claimToken, claimToken),
              ),
            );
        }),
      );
      return Result.err(extractionResult.error);
    }

    const finalized = yield* Result.await(
      safeDb(async (tx) => {
        // audit: skip — terminal upload bookkeeping, not a domain mutation
        const [row] = await tx
          .update(contactExtractionUploads)
          .set({
            status: "used",
            claimToken: null,
            processingStartedAt: null,
            usedAt: new Date(),
          })
          .where(
            and(
              eq(contactExtractionUploads.id, upload.id),
              eq(contactExtractionUploads.organizationId, organizationId),
              eq(contactExtractionUploads.userId, user.id),
              eq(contactExtractionUploads.status, "processing"),
              eq(contactExtractionUploads.claimToken, claimToken),
            ),
          )
          .returning({ id: contactExtractionUploads.id });
        return row ?? null;
      }),
    );
    if (!finalized) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "The extraction upload lease expired; retry the upload.",
        }),
      );
    }

    getS3().delete(key).catch(captureError);

    return extractionResult;
  },
);

export default extractProcuracao;
