import * as v from "valibot";

import { SKILL_INVOCATION } from "@/api/lib/agent-skills/invocation";

/**
 * A skill's invocation as a request field. A plain literal union, so an
 * absent optional field stays absent instead of coercing to the first member.
 */
export const tSkillInvocation = () =>
  v.union([
    v.literal(SKILL_INVOCATION.auto),
    v.literal(SKILL_INVOCATION.manual),
  ]);
