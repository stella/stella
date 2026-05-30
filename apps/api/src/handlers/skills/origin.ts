import { Result } from "better-result";

import type { AgentSkillOrigin } from "@/api/db/schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const EDITABLE_AGENT_SKILL_ORIGINS = new Set<AgentSkillOrigin>([
  "upload",
  "url",
]);

export const requireEditableSkillOrigin = (
  origin: AgentSkillOrigin,
): Result<void, HandlerError> => {
  if (EDITABLE_AGENT_SKILL_ORIGINS.has(origin)) {
    return Result.ok(undefined);
  }

  return Result.err(
    new HandlerError({
      status: 403,
      message: "Bundled skills cannot be edited",
    }),
  );
};
