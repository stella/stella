import { Result } from "better-result";
import { t } from "elysia";

import type { AGENT_SKILL_SCOPES } from "@/api/db/schema";
import { env } from "@/api/env";
import {
  installSkill,
  preflightSkillInstall,
} from "@/api/handlers/skills/install";
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
    const scope = body.scope ?? "team";
    const preflightResult = await preflightSkillInstall({
      memberRole,
      safeDb,
      scope,
      session,
      slug: body.slug,
      user,
    });
    if (Result.isError(preflightResult)) {
      return yield* Result.err(preflightResult.error);
    }

    const resolvedResult = await resolveCatalogueSkillPackage(body.slug, {
      ...(env.GITHUB_TOKEN ? { githubToken: env.GITHUB_TOKEN } : {}),
    });
    if (Result.isError(resolvedResult)) {
      return yield* Result.err(resolvedResult.error);
    }

    const installResult = await installSkill({
      memberRole,
      // Both in-tree and github-sourced catalogue skills are curated content
      // pinned by the catalogue (github skills by commit SHA), so they use the
      // non-editable `bundled` origin rather than the user-editable `url`
      // origin; re-installing is how an updated catalogue entry propagates.
      origin: "bundled",
      parsed: resolvedResult.value.package,
      recordAuditEvent,
      safeDb,
      scope,
      session,
      // Store the catalogue slug, never the upstream frontmatter name: a
      // github skill whose SKILL.md `name` differs from the catalogue slug
      // must still install under the slug so install-state matching,
      // re-install detection, and uninstall can find the row. In-tree skills
      // already guarantee name == slug, so this is a structural no-op there.
      slug: resolvedResult.value.installSlug,
      user,
    });
    if (installResult.isErr()) {
      return yield* Result.err(installResult.error);
    }

    return Result.ok({ slug: resolvedResult.value.installSlug });
  },
);

export default installBundledSkill;
