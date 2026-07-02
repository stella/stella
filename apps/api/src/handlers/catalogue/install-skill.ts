import { Result } from "better-result";
import { t } from "elysia";

import type { AGENT_SKILL_SCOPES } from "@/api/db/schema";
import { installSkill } from "@/api/handlers/skills/install";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";

import { resolveCatalogueSkillPackage } from "./catalogue-skill-package";

const installSkillScopeValues = [
  "team",
  "private",
] as const satisfies typeof AGENT_SKILL_SCOPES;

const installSkillBody = t.Object({
  slug: t.String({ minLength: 1, maxLength: 64 }),
  // Literals are inlined rather than `AGENT_SKILL_SCOPES.map(...)`: mapping the
  // const yields a non-tuple union that Elysia infers as `never`, collapsing
  // `scope` to `undefined`; the tuple above keeps schema drift type-checked.
  scope: t.Optional(
    t.Union([
      t.Literal(installSkillScopeValues[0]),
      t.Literal(installSkillScopeValues[1]),
    ]),
  ),
});

const config = {
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "capability", reason: "agent_tool_authoring" },
  body: installSkillBody,
} satisfies HandlerConfig;

const installBundledSkill = createSafeRootHandler(
  config,
  async function* ({
    body,
    memberRole,
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    const parsedResult = await resolveCatalogueSkillPackage(body.slug);
    if (Result.isError(parsedResult)) {
      return yield* Result.err(parsedResult.error);
    }

    const installResult = await installSkill({
      memberRole,
      // Both in-tree and github-sourced catalogue skills are curated content
      // pinned by the catalogue (github skills by commit SHA), so they use the
      // non-editable `bundled` origin rather than the user-editable `url`
      // origin; re-installing is how an updated catalogue entry propagates.
      origin: "bundled",
      parsed: parsedResult.value,
      recordAuditEvent,
      safeDb,
      scope: body.scope ?? "team",
      session,
      user,
    });
    if (installResult.isErr()) {
      return yield* Result.err(installResult.error);
    }

    return Result.ok({ slug: parsedResult.value.name });
  },
);

export default installBundledSkill;
