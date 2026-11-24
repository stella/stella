import { Result } from "better-result";
import * as v from "valibot";

import { SKILL_RESOURCE_REFUSAL_CODE } from "@stll/api-contract";
import { isKnownBinaryResourcePath } from "@stll/skills/format";

import { agentSkillResources } from "@/api/db/schema";
import { skillRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { loadSkillForNewResource } from "@/api/handlers/skills/resources/new-resource-skill";
import {
  lockSkillForResourceWrite,
  refreshSkillContentHash,
} from "@/api/lib/agent-skills/content-hash";
import {
  abandonSkillResourceOriginals,
  binarySkillResourceText,
  originalColumns,
  publishSkillResourceOriginals,
  storeSkillResourceOriginals,
} from "@/api/lib/agent-skills/resource-originals";
import type { SkillResourceOriginalFile } from "@/api/lib/agent-skills/resource-originals";
import {
  RESOURCE_PATH_MAX_CHARS,
  RESOURCE_PATH_PATTERN,
} from "@/api/lib/agent-skills/resource-path";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { fileSchema, resourceIdSchema } from "@/api/lib/custom-schema";
import { withAggregateSavepoint } from "@/api/lib/db/aggregate-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { scanUploadForHandler } from "@/api/lib/file-scan/scan-upload-handler";
import { readZipNameCodePage } from "@/api/lib/files/organization-zip-name-code-page";
import { FILE_SIZE_LIMIT_BYTES, LIMITS } from "@/api/lib/limits";
import { writeS3ObjectWithRetry } from "@/api/lib/s3";
import { extractFileText } from "@/api/lib/search/extract-content";
import {
  DOCX_MIME_TYPE,
  OCTET_STREAM_MIME_TYPE,
  PDF_MIME_TYPE,
} from "@/api/mime-types";

const inferBinaryUploadMimeType = ({
  file,
  path,
}: {
  file: File;
  path: string;
}): string | null => {
  if (file.type === DOCX_MIME_TYPE || file.type === PDF_MIME_TYPE) {
    return file.type;
  }

  const filename = file.name.toLowerCase();
  const resourcePath = path.toLowerCase();
  if (filename.endsWith(".docx") || resourcePath.endsWith(".docx")) {
    return DOCX_MIME_TYPE;
  }
  if (filename.endsWith(".pdf") || resourcePath.endsWith(".pdf")) {
    return PDF_MIME_TYPE;
  }

  return null;
};

const uploadSkillResourceParamsSchema = v.object({
  skillId: resourceIdSchema("agentSkill"),
});

const uploadSkillResourceBodySchema = v.object({
  path: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(RESOURCE_PATH_MAX_CHARS),
  ),
  file: fileSchema({ maxBytes: FILE_SIZE_LIMIT_BYTES.skillResource }),
});

const config = {
  contract: "patch",
  contentDelivery: {
    type: "none",
    reason:
      "Stores an uploaded skill file and its original without delivering stored-file bytes.",
  },
  description:
    "Add one file to an agent skill by uploading it. A DOCX or PDF is stored " +
    "as its extracted text and a UTF-8 text file as its text; a DOCX, a PDF " +
    "and a file with no text (an image, an archive) also keep the uploaded " +
    "bytes, which an export returns unchanged. A file " +
    "whose text exceeds the per-file character limit is rejected whole. " +
    "The path, duplicate, file-count, and editability rules match " +
    "skills.resources.create, which takes the text directly as JSON.",
  permissions: { agentSkill: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: skillRealtimeUpdates,
  mcp: {
    type: "capability",
    reason: "agent_tool_authoring",
    consumesServices: true,
  },
  transport: {
    type: "file-input",
    input: {
      field: "file",
      required: true,
      // Empty because the handler enforces no media type: DOCX and PDF go
      // through extraction, text is stored as text, and any other file is
      // kept as its bytes. Listing
      // the two extracted types would make a client reject the text uploads
      // this endpoint accepts.
      mediaTypes: [],
    },
    alternative: {
      type: "partial",
      via: ["skills.resources.create"],
      limitation:
        "creates a resource from text `content`; a binary DOCX/PDF resource has no JSON form",
    },
  },
  params: uploadSkillResourceParamsSchema,
  body: uploadSkillResourceBodySchema,
} satisfies HandlerConfig;

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/** A file's text, or null for bytes that are not text (invalid UTF-8, NUL). */
const decodeText = (bytes: ArrayBuffer): string | null => {
  const text = Result.try(() => UTF8_DECODER.decode(bytes)).unwrapOr(null);
  return text === null || text.includes("\0") ? null : text;
};

/** `writeObject` is injected by tests; production writes to object storage. */
export const createUploadSkillResource = (
  writeObject = writeS3ObjectWithRetry,
) =>
  createSafeRootHandler(
    config,
    async function* ({
      body,
      memberRole,
      params,
      recordAuditEvent,
      safeDb,
      session,
      user,
    }) {
      const path = body.path.trim();
      if (
        !path ||
        path.length > RESOURCE_PATH_MAX_CHARS ||
        !RESOURCE_PATH_PATTERN.test(path)
      ) {
        return Result.err(
          new HandlerError({
            status: 400,
            code: SKILL_RESOURCE_REFUSAL_CODE.pathInvalid,
            message: "Invalid resource path",
          }),
        );
      }

      const skill = yield* Result.await(
        loadSkillForNewResource({
          safeDb,
          skillId: params.skillId,
          organizationId: session.activeOrganizationId,
          memberRole,
          userId: user.id,
          path,
        }),
      );

      const buffer = await body.file.arrayBuffer();
      const binaryMimeType = inferBinaryUploadMimeType({
        file: body.file,
        path,
      });
      const text =
        binaryMimeType === null && !isKnownBinaryResourcePath(path)
          ? decodeText(buffer)
          : null;

      let content: string;
      // The uploaded bytes, kept beside the text for a DOCX, a PDF or a file
      // with no text; a text file is its own original.
      let original: SkillResourceOriginalFile | null = null;
      if (text !== null) {
        content = text;
      } else if (binaryMimeType === null) {
        const scanned = yield* Result.await(
          scanUploadForHandler({
            bytes: buffer,
            declaredMimeType: body.file.type || OCTET_STREAM_MIME_TYPE,
            fileName: path,
          }),
        );
        const mediaType = scanned.mimeType || OCTET_STREAM_MIME_TYPE;
        original = { bytes: new Uint8Array(scanned.bytes), mediaType, path };
        content = binarySkillResourceText({
          mediaType,
          path,
          sizeBytes: scanned.bytes.byteLength,
        });
      } else {
        const scanned = yield* Result.await(
          scanUploadForHandler({
            bytes: buffer,
            declaredMimeType: binaryMimeType,
            fileName: path,
          }),
        );
        // One character past the cap, so a longer text is refused below
        // rather than stored cut short.
        const zipNameCodePage = yield* Result.await(
          safeDb(
            async (tx) =>
              await readZipNameCodePage(tx, session.activeOrganizationId),
          ),
        );
        const extracted = await extractFileText(
          scanned,
          { source: "skill-resource-upload", skillId: params.skillId },
          {
            maxChars: LIMITS.agentSkillResourceMaxChars + 1,
            zipNameCodePage,
          },
        );
        if (!extracted) {
          return Result.err(
            new HandlerError({
              status: 422,
              code: SKILL_RESOURCE_REFUSAL_CODE.textUnreadable,
              message: "Could not extract text from this file",
            }),
          );
        }
        content = extracted;
        original = {
          bytes: new Uint8Array(scanned.bytes),
          mediaType: binaryMimeType,
          path,
        };
      }
      // Refused whole rather than cut short: a truncated reference file would
      // read as complete to every later reader.
      if (content.length > LIMITS.agentSkillResourceMaxChars) {
        return Result.err(
          new HandlerError({
            status: 413,
            code: SKILL_RESOURCE_REFUSAL_CODE.tooLarge,
            message: "This file's text exceeds the maximum resource size",
          }),
        );
      }

      const sizeBytes = new TextEncoder().encode(content).byteLength;

      // Stored before the transaction that names it; abandoned (and so
      // erased by recovery) when that transaction does not commit.
      const stored = yield* Result.await(
        storeSkillResourceOriginals({
          files: original === null ? [] : [original],
          organizationId: session.activeOrganizationId,
          safeDb,
          writeObject,
        }),
      );
      const storedOriginal = stored.originals.get(path);

      const insertResult = await safeDb(
        async (tx) =>
          await withAggregateSavepoint(tx, async (innerTx) => {
            await publishSkillResourceOriginals(innerTx, stored);
            const lockedSkill = await lockSkillForResourceWrite(
              innerTx,
              params.skillId,
            );
            const rows = await innerTx
              .insert(agentSkillResources)
              .values({
                organizationId: session.activeOrganizationId,
                skillId: params.skillId,
                path,
                content,
                sizeBytes,
                ...(storedOriginal === undefined
                  ? {}
                  : originalColumns(storedOriginal)),
              })
              .returning({
                id: agentSkillResources.id,
                path: agentSkillResources.path,
                content: agentSkillResources.content,
                sizeBytes: agentSkillResources.sizeBytes,
              });
            await refreshSkillContentHash(innerTx, lockedSkill);

            await recordAuditEvent(innerTx, {
              action: AUDIT_ACTION.CREATE,
              resourceType: AUDIT_RESOURCE_TYPE.AGENT_SKILL,
              resourceId: params.skillId,
              changes: {
                resource: {
                  old: null,
                  new: { path, sizeBytes },
                },
              },
              metadata: { slug: skill.slug, path, origin: "upload" },
            });

            return rows;
          }),
      );
      if (Result.isError(insertResult)) {
        await abandonSkillResourceOriginals({ safeDb, stored });
      }
      const inserted = yield* insertResult;

      const row = inserted.at(0);
      if (!row) {
        return Result.err(
          new HandlerError({ status: 500, message: "Could not create file" }),
        );
      }

      return Result.ok({
        id: row.id,
        skillId: params.skillId,
        path: row.path,
        content: row.content,
        sizeBytes: row.sizeBytes,
      });
    },
  );

const uploadSkillResource = createUploadSkillResource();

export default uploadSkillResource;
