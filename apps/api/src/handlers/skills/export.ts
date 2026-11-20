import { Result } from "better-result";
import * as v from "valibot";

import {
  SKILL_PACKAGE_FILE_TYPES,
  SKILL_PACKAGE_FORMATS,
  skillPackageFileName,
} from "@stll/skills/package";
import { Temporal } from "@stll/time";

import {
  loadSkillPackageSource,
  readStoredSkillOriginal,
  type SkillOriginalReader,
  withSkillOriginals,
  writeSkillPackageArchive,
} from "@/api/lib/agent-skills/skill-export";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { auditedPresignDownload } from "@/api/lib/audited-download";
import { ownerSyntheticSessionAuthorityReader } from "@/api/lib/auth";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";
import { writeS3ObjectWithRetry } from "@/api/lib/s3";
import { callerDownloadSource } from "@/api/lib/s3-presign";

/** The download URL is handed straight to the client to fetch, not kept. */
const SKILL_EXPORT_URL_TTL_SECONDS = 300;

const config = {
  contract: "patch",
  contentDelivery: { type: "audited" },
  description:
    "Export one agent skill the caller can read as a portable skill package: " +
    "a folder named after the skill's slug holding SKILL.md (frontmatter " +
    "with its settings, then the instructions), every file of the skill (an " +
    "uploaded or imported file byte for byte as it was stored, text kept " +
    "from a PDF or DOCX without its original as .md), and " +
    ".stella/manifest.json (format version, display name, slash command, and " +
    "a SHA-256 per file). `format` is `zip` or `skill`: the same archive under " +
    "a .zip or .skill file name, which skills.upload imports again. A skill " +
    "bound to a matter or client exports without that binding. Returns a " +
    "short-lived downloadUrl, fileName and expiresAt; hand the URL to the " +
    "user without reading the archive bytes.",
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  // Writes the archive and its download audit row; the skill is only read.
  access: "write",
  mcp: {
    type: "capability",
    reason: "agent_tool_authoring",
    consumesServices: false,
  },
  params: v.object({ skillId: resourceIdSchema("agentSkill") }),
  query: v.object({
    format: v.pipe(
      v.picklist(SKILL_PACKAGE_FORMATS),
      v.description(
        "zip or skill: the same skill package archive, named .zip or .skill",
      ),
    ),
  }),
  realtime: noResourceSetUpdates(
    "Stores a temporary export download; nothing a web view lists changes.",
  ),
} satisfies HandlerConfig;

export const createSkillExport = (
  writeObject = writeS3ObjectWithRetry,
  readObject: SkillOriginalReader = readStoredSkillOriginal,
) =>
  createSafeRootHandler(
    config,
    async function* ({
      params: { skillId },
      query: { format },
      recordAuditEvent,
      safeDb,
      session,
      user,
    }) {
      const organizationId = session.activeOrganizationId;
      // The transaction answers with the load's own outcome: a skill the
      // caller cannot read is a 404, not a database failure.
      const read = yield* Result.await(
        safeDb(
          async (tx) =>
            await loadSkillPackageSource(tx, {
              organizationId,
              skillId,
              userId: user.id,
            }),
        ),
      );
      const loaded = yield* read;
      // Originals are read after the transaction: object storage is no part
      // of it.
      const source = yield* Result.await(
        withSkillOriginals({ loaded, organizationId, readObject }),
      );
      const archive = await writeSkillPackageArchive(source);
      const fileName = skillPackageFileName(source.slug, format);
      // `exports/` leads the key for object-lifecycle cleanup; the signer
      // receives the matching exports keyspace and the organization scope.
      const key = `exports/${organizationId}/skills/${skillId}/${Bun.randomUUIDv7()}.${SKILL_PACKAGE_FILE_TYPES[format].extension}`;
      yield* Result.await(
        Result.tryPromise({
          try: async () =>
            await writeObject(
              {
                contentType: SKILL_PACKAGE_FILE_TYPES[format].mediaType,
                data: archive,
                key,
              },
              { type: "lifecycle-prefix", prefix: "exports/" },
            ),
          catch: (cause) =>
            new HandlerError({
              status: 502,
              code: "internal_error",
              message: "The skill package could not be stored.",
              cause,
            }),
        }),
      );
      const downloadUrl = yield* Result.await(
        safeDb(
          async (tx) =>
            await auditedPresignDownload({
              readSessionAuthority: ownerSyntheticSessionAuthorityReader,
              tx,
              recordAuditEvent,
              resourceType: AUDIT_RESOURCE_TYPE.AGENT_SKILL,
              resourceId: skillId,
              userId: user.id,
              source: callerDownloadSource(session),
              s3Key: key,
              s3Keyspace: "exports",
              expiresInSeconds: SKILL_EXPORT_URL_TTL_SECONDS,
              fileName,
              organizationId,
              workspaceId: null,
              metadata: {
                fileCount: loaded.resourceCount,
                format,
                sizeBytes: archive.byteLength,
                slug: source.slug,
              },
            }),
        ),
      );
      return Result.ok({
        downloadUrl,
        expiresAt: Temporal.Now.instant()
          .add({ seconds: SKILL_EXPORT_URL_TTL_SECONDS })
          .toString(),
        fileName,
        format,
      });
    },
  );

const exportSkill = createSkillExport();

declareAggregateMutation(exportSkill, {
  type: "independent",
  reason:
    "Reads one skill and writes only a temporary export object and its download audit event; no skill row changes.",
});

export default exportSkill;
