import { Result } from "better-result";
import { t } from "elysia";

import { AGENT_SKILL_SCOPES } from "@/api/db/schema";
import { skillRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { validateDocxArchive } from "@/api/lib/docx-archive";
import { scanUploadForHandler } from "@/api/lib/file-scan/scan-upload-handler";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";
import {
  authorizeSkillInstallScope,
  installSkill,
} from "@/api/lib/skills/install";
import {
  isZipSkillSource,
  parseUploadedSkillPackage,
  SKILL_ARCHIVE_OPTIONS,
} from "@/api/lib/skills/skill-package";

const uploadSkillBodySchema = t.Object({
  scope: t.UnionEnum(AGENT_SKILL_SCOPES),
  file: t.File({ maxSize: FILE_SIZE_LIMITS.skillPack }),
});

const config = {
  contentDelivery: {
    type: "none",
    reason: "Stores a skill upload without delivering stored-file bytes.",
  },
  description:
    "Install an agent skill by uploading a skill pack or a bare SKILL.md " +
    "file; the parser reads the bytes rather than trusting the declared " +
    "media type. It is stored with an upload origin and stays editable. Team " +
    "scope requires admin or owner.",
  permissions: { agentSkill: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: skillRealtimeUpdates,
  mcp: {
    type: "capability",
    reason: "agent_tool_authoring",
    consumesServices: false,
  },
  transport: {
    type: "file-input",
    // Any declared type: the package parser sniffs the bytes (zip pack or a
    // bare markdown skill) rather than trusting `file.type`.
    input: { field: "file", required: true, mediaTypes: [] },
    alternative: {
      type: "complete",
      via: ["uploads.create", "uploads.update"],
      note: "presign with purpose agent_skill, PUT the skill pack to the returned URL, then finalize",
    },
  },
  body: uploadSkillBodySchema,
} satisfies HandlerConfig;

const uploadSkill = createSafeRootHandler(
  config,
  async function* ({
    body,
    memberRole,
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    const authorization = authorizeSkillInstallScope({
      memberRole,
      scope: body.scope,
    });
    if (Result.isError(authorization)) {
      return Result.err(authorization.error);
    }

    const bytes = await body.file.arrayBuffer();
    if (
      isZipSkillSource({
        buffer: bytes,
        contentType: body.file.type,
        path: body.file.name,
      })
    ) {
      yield* Result.await(validateDocxArchive(bytes, SKILL_ARCHIVE_OPTIONS));
    }

    const scanned = yield* Result.await(
      scanUploadForHandler({
        bytes,
        declaredMimeType: body.file.type,
        fileName: sanitizeFilenamePreservingExtension(body.file.name),
      }),
    );
    const parsed = yield* Result.await(parseUploadedSkillPackage(scanned));

    const installResult = await installSkill({
      memberRole,
      origin: "upload",
      parsed,
      recordAuditEvent,
      safeDb,
      scope: body.scope,
      session,
      user,
    });
    if (installResult.isErr()) {
      return Result.err(installResult.error);
    }

    return Result.ok({
      ...installResult.value,
      skippedFiles: parsed.skippedFiles,
    });
  },
);

export default uploadSkill;
