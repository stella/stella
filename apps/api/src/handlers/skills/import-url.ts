import { Result } from "better-result";
import { t } from "elysia";

import { AGENT_SKILL_SCOPES } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

import { authorizeSkillInstallScope, installSkill } from "./install";
import { fetchSkillPackageFromUrl } from "./skill-package";

const importSkillBodySchema = t.Object({
  scope: t.UnionEnum(AGENT_SKILL_SCOPES),
  url: t.String({ minLength: 1, maxLength: 2048 }),
});

const config = {
  permissions: { agentSkill: ["create"] },
  body: importSkillBodySchema,
} satisfies HandlerConfig;

const importSkillFromUrl = createSafeRootHandler(
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

    const parsed = yield* Result.await(fetchSkillPackageFromUrl(body.url));

    const installResult = await installSkill({
      memberRole,
      origin: "url",
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

export default importSkillFromUrl;
