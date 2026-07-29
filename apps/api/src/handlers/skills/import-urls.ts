import { Result } from "better-result";
import { t } from "elysia";

import { AGENT_SKILL_SCOPES } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

import { authorizeSkillInstallScope, installSkill } from "./install";
import { fetchSkillPackageFromUrl } from "./skill-package";

const MAX_SKILL_IMPORTS = 20;

const importSkillsBodySchema = t.Object({
  scope: t.UnionEnum(AGENT_SKILL_SCOPES),
  urls: t.Array(t.String({ minLength: 1, maxLength: 2048 }), {
    minItems: 1,
    maxItems: MAX_SKILL_IMPORTS,
  }),
});

const config = {
  permissions: { agentSkill: ["create"] },
  mcp: { type: "capability", reason: "agent_tool_authoring" },
  body: importSkillsBodySchema,
} satisfies HandlerConfig;

const importSkillsFromUrls = createSafeRootHandler(
  config,
  // eslint-disable-next-line require-yield -- createSafeRootHandler expects a Result generator; per-item failures are collected instead of yielded.
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

    const installed: { id: string; sourceUrl: string }[] = [];
    const failed: { message: string; sourceUrl: string }[] = [];
    const sourceUrls = [...new Set(body.urls.map((url) => url.trim()))];

    for (const sourceUrl of sourceUrls) {
      // oxlint-disable-next-line no-await-in-loop -- imports are sequential to bound external fetches and database transactions
      const parsed = await fetchSkillPackageFromUrl(sourceUrl);
      if (Result.isError(parsed)) {
        failed.push({ message: parsed.error.message, sourceUrl });
        continue;
      }

      // oxlint-disable-next-line no-await-in-loop -- each install has its own audited transaction; a failed item must not roll back successful siblings
      const result = await installSkill({
        memberRole,
        origin: "url",
        parsed: parsed.value,
        recordAuditEvent,
        safeDb,
        scope: body.scope,
        session,
        user,
      });
      if (result.isErr()) {
        failed.push({ message: result.error.message, sourceUrl });
        continue;
      }
      installed.push({ id: result.value.id, sourceUrl });
    }

    return Result.ok({ failed, installed });
  },
);

export default importSkillsFromUrls;
