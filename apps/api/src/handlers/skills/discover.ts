import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

import { discoverSkillPackagesFromUrl } from "./skill-package";

const discoverSkillUrlBodySchema = t.Object({
  url: t.String({ minLength: 1, maxLength: 2048 }),
});

const config = {
  description:
    "Discover importable skills from a GitHub repository or SKILL.md URL.",
  permissions: { agentSkill: ["create"] },
  mcp: { type: "capability", reason: "agent_tool_authoring" },
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
