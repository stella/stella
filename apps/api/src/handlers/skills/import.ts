import { Result } from "better-result";
import { t } from "elysia";

import type { AGENT_SKILL_SCOPES } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

import { deduplicateSkillImportItems } from "./import-urls.logic";
import { authorizeSkillInstallScope, installSkill } from "./install";
import {
  createSkillPackageFetchContext,
  fetchSkillPackageFromUrl,
  verifySkillPackageIntegrity,
} from "./skill-package";

const MAX_SKILL_IMPORTS = 20;
// Bound the whole batch, not each raw file independently. The request cap
// accommodates typical multi-skill repositories while preventing a maximal
// 20-skill selection from issuing more than a small fixed number of requests.
const SKILL_IMPORT_TIMEOUT_MS = 30_000;
const SKILL_IMPORT_MAX_REQUESTS = 128;
const CONTENT_HASH_PATTERN = "^[a-f0-9]{64}$";
const GITHUB_COMMIT_SHA_PATTERN = "^[a-f0-9]{40}$";
const importSkillScopeValues = [
  "team",
  "private",
] as const satisfies typeof AGENT_SKILL_SCOPES;

export const importSkillsBodySchema = t.Object({
  items: t.Array(
    t.Object({
      integrity: t.Union([
        t.Object({
          type: t.Literal("content-hash"),
          value: t.String({ pattern: CONTENT_HASH_PATTERN }),
        }),
        t.Object({
          entrypointHash: t.String({ pattern: CONTENT_HASH_PATTERN }),
          sourceUrl: t.String({ minLength: 1, maxLength: 2048 }),
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
  scope: t.Union([
    t.Literal(importSkillScopeValues[0]),
    t.Literal(importSkillScopeValues[1]),
  ]),
});

const config = {
  description:
    "Import one or more discovered skills from source URLs into the selected scope.",
  permissions: { agentSkill: ["create"] },
  mcp: { type: "capability", reason: "agent_tool_authoring" },
  body: importSkillsBodySchema,
} satisfies HandlerConfig;

const importSkillsFromUrls = createSafeRootHandler(
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
      return yield* Result.err(authorization.error);
    }

    const installed: { id: string; sourceUrl: string }[] = [];
    const deduplicated = deduplicateSkillImportItems(body.items);
    const failed = [...deduplicated.failed];
    const { items } = deduplicated;
    const fetchContext = createSkillPackageFetchContext({
      deadlineAt: Date.now() + SKILL_IMPORT_TIMEOUT_MS,
      maxRequests: SKILL_IMPORT_MAX_REQUESTS,
    });
    const importAt = async (index: number): Promise<void> => {
      const item = items.at(index);
      if (item === undefined) {
        return;
      }
      const { integrity, sourceUrl } = item;
      const parsed = await fetchSkillPackageFromUrl(sourceUrl, fetchContext);
      if (Result.isError(parsed)) {
        failed.push({ message: parsed.error.message, sourceUrl });
        return importAt(index + 1);
      }

      const verification = verifySkillPackageIntegrity({
        integrity,
        parsed: parsed.value,
        sourceUrl,
      });
      if (Result.isError(verification)) {
        failed.push({ message: verification.error.message, sourceUrl });
        return importAt(index + 1);
      }

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
        return importAt(index + 1);
      }
      installed.push({ id: result.value.id, sourceUrl });
      return importAt(index + 1);
    };

    await importAt(0);

    return Result.ok({ failed, installed });
  },
);

export default importSkillsFromUrls;
