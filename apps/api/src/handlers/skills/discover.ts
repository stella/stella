import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS } from "@/api/lib/auth/demo-account-policy";
import { discoverSkillPackagesFromUrl } from "@/api/lib/skills/skill-package";

const discoverSkillUrlBodySchema = t.Object({
  url: t.String({ minLength: 1, maxLength: 2048 }),
});

const config = {
  description:
    "Discover importable skills from a GitHub repository or SKILL.md URL.",
  permissions: { agentSkill: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "agent_tool_authoring",
    consumesServices: false,
  },
  body: discoverSkillUrlBodySchema,
} satisfies HandlerConfig;

const discoverSkillUrl = createSafeRootHandler(
  config,
  async function* ({ body }) {
    const discovery = yield* Result.await(
      discoverSkillPackagesFromUrl(body.url),
    );
    return Result.ok(discovery);
  },
);

export default discoverSkillUrl;
