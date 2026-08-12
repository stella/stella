import { Result } from "better-result";
import { t } from "elysia";

import { AGENT_SKILL_SCOPES } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";
import {
  authorizeSkillInstallScope,
  installSkill,
} from "@/api/lib/skills/install";
import { parseUploadedSkillPackage } from "@/api/lib/skills/skill-package";

const uploadSkillBodySchema = t.Object({
  scope: t.UnionEnum(AGENT_SKILL_SCOPES),
  file: t.File({ maxSize: FILE_SIZE_LIMITS.skillPack }),
});

const config = {
  description:
    "Install an agent skill by uploading a skill pack or a bare SKILL.md " +
    "file; the parser reads the bytes rather than trusting the declared " +
    "media type. It is stored with an upload origin and stays editable. Team " +
    "scope requires admin or owner.",
  permissions: { agentSkill: ["create"] },
  mcp: { type: "capability", reason: "agent_tool_authoring" },
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

    const parsed = yield* Result.await(parseUploadedSkillPackage(body.file));

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

    return Result.ok(installResult.value);
  },
);

export default uploadSkill;
