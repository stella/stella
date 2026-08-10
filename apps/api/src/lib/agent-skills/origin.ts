import { Result } from "better-result";

import { AGENT_SKILL_ORIGINS, type AgentSkillOrigin } from "@/api/db/schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const AGENT_SKILL_ORIGIN_EDITABILITY = {
  authored: "editable",
  bundled: "read-only",
  upload: "editable",
  url: "editable",
} as const satisfies Record<AgentSkillOrigin, "editable" | "read-only">;

export type EditableAgentSkillOrigin = {
  [TOrigin in AgentSkillOrigin]: (typeof AGENT_SKILL_ORIGIN_EDITABILITY)[TOrigin] extends "editable"
    ? TOrigin
    : never;
}[AgentSkillOrigin];

const isEditableAgentSkillOrigin = (
  origin: AgentSkillOrigin,
): origin is EditableAgentSkillOrigin =>
  AGENT_SKILL_ORIGIN_EDITABILITY[origin] === "editable";

export const EDITABLE_AGENT_SKILL_ORIGINS = AGENT_SKILL_ORIGINS.filter(
  isEditableAgentSkillOrigin,
);

const EDITABLE_AGENT_SKILL_ORIGIN_SET = new Set<AgentSkillOrigin>(
  EDITABLE_AGENT_SKILL_ORIGINS,
);

export const requireEditableSkillOrigin = (
  origin: AgentSkillOrigin,
): Result<void, HandlerError> => {
  if (EDITABLE_AGENT_SKILL_ORIGIN_SET.has(origin)) {
    return Result.ok(undefined);
  }

  return Result.err(
    new HandlerError({
      status: 403,
      message: "Bundled skills cannot be edited",
    }),
  );
};
