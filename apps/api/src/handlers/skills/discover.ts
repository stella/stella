import { Result } from "better-result";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { discoverSkillPackagesFromUrl } from "@/api/lib/skills/skill-package";

const discoverSkillUrlBodySchema = v.object({
  url: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)),
});

const config = {
  contract: "patch",
  contentDelivery: {
    type: "none",
    reason: "Returns skill discovery metadata from an external source.",
  },
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
      discoverSkillPackagesFromUrl({
        permit: grantThirdPartyOutboundPermit(),
        rawUrl: body.url,
      }),
    );
    return Result.ok(discovery);
  },
);

export default discoverSkillUrl;
