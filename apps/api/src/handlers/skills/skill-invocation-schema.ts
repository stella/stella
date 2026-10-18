import { t } from "elysia";

import { SKILL_INVOCATION } from "@/api/lib/agent-skills/invocation";

/**
 * A skill's invocation as a request field. A plain literal union, so an
 * absent optional field stays absent instead of coercing to the first member.
 */
export const tSkillInvocation = () =>
  t.Union([
    t.Literal(SKILL_INVOCATION.auto),
    t.Literal(SKILL_INVOCATION.manual),
  ]);
