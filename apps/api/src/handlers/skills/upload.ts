import { Result } from "better-result";
import { t } from "elysia";

import { AGENT_SKILL_SCOPES } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";

import { authorizeSkillInstallScope, installSkill } from "./install";
import { parseUploadedSkillPackage } from "./skill-package";

const uploadSkillBodySchema = t.Object({
  scope: t.UnionEnum(AGENT_SKILL_SCOPES),
  file: t.File({ maxSize: FILE_SIZE_LIMITS.skillPack }),
});

const config = {
  permissions: { agentSkill: ["create"] },
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
