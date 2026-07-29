import { Result } from "better-result";
import { t } from "elysia";

import { AGENT_SKILL_SCOPES } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

import { authorizeSkillInstallScope, installSkill } from "./install";
import {
  fetchSkillPackageFromUrl,
  verifySkillPackageIntegrity,
} from "./skill-package";

const MAX_SKILL_IMPORTS = 20;
const CONTENT_HASH_PATTERN = "^[a-f0-9]{64}$";
const GITHUB_COMMIT_SHA_PATTERN = "^[a-f0-9]{40}$";

const importSkillsBodySchema = t.Object({
  items: t.Array(
    t.Object({
      integrity: t.Union([
        t.Object({
          type: t.Literal("content-hash"),
          value: t.String({ pattern: CONTENT_HASH_PATTERN }),
        }),
        t.Object({
          type: t.Literal("github-commit"),
          value: t.String({ pattern: GITHUB_COMMIT_SHA_PATTERN }),
        }),
      ]),
      sourceUrl: t.String({ minLength: 1, maxLength: 2048 }),
    }),
    {
      minItems: 1,
      maxItems: MAX_SKILL_IMPORTS,
    },
  ),
  scope: t.UnionEnum(AGENT_SKILL_SCOPES),
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
    const itemsBySourceUrl = new Map(
      body.items.map((item) => [
        item.sourceUrl.trim(),
        {
          integrity: item.integrity,
          sourceUrl: item.sourceUrl.trim(),
        },
      ]),
    );

    for (const { integrity, sourceUrl } of itemsBySourceUrl.values()) {
      // oxlint-disable-next-line no-await-in-loop -- imports are sequential to bound external fetches and database transactions
      const parsed = await fetchSkillPackageFromUrl(sourceUrl);
      if (Result.isError(parsed)) {
        failed.push({ message: parsed.error.message, sourceUrl });
        continue;
      }

      const verification = verifySkillPackageIntegrity({
        integrity,
        parsed: parsed.value,
        sourceUrl,
      });
      if (Result.isError(verification)) {
        failed.push({ message: verification.error.message, sourceUrl });
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
