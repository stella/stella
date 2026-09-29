import { Result, TaggedError } from "better-result";

import { BUILT_IN_CHAT_TOOL_POLICY_KINDS } from "@stll/api-contract";
import {
  readSkillRequiredTools,
  SKILL_REQUIRED_TOOLS_MAX,
  SKILL_REQUIRED_TOOLS_METADATA_KEY,
} from "@stll/skills";

import { MCP_STATIC_TOOL_NAMES } from "@/api/mcp/static-tool-definitions";

// Kept apart from `required-tools.ts`: this module reads the tool registry,
// which the availability helpers' importers (the registry among them) must not.

/**
 * Skill tools a skill cannot require: they exist only because skills do, so
 * a skill's availability is decided over every other tool of the surface.
 */
const SKILL_OWN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "create-current-skill-resource",
  "load-skill",
  "read-skill-resource",
  "update-current-skill-body",
  "update-current-skill-resource",
]);

let requirableToolNames: ReadonlySet<string> | undefined;

/**
 * Every name `stella-required-tools` may list: the tool registry (what MCP
 * serves and chat projects) plus chat's own tools, such as `ask-user`.
 * Built on first use so importing this module never evaluates the registry
 * during another module's initialisation.
 */
export const skillRequirableToolNames = (): ReadonlySet<string> => {
  requirableToolNames ??= new Set(
    [
      ...MCP_STATIC_TOOL_NAMES,
      ...Object.keys(BUILT_IN_CHAT_TOOL_POLICY_KINDS),
    ].filter((name) => !SKILL_OWN_TOOL_NAMES.has(name)),
  );
  return requirableToolNames;
};

export class SkillRequiredToolsError extends TaggedError(
  "SkillRequiredToolsError",
)<{ message: string }> {}

/**
 * Save-time check of a skill's `stella-required-tools`: every name must be a
 * tool stella has, and the list stays short. A skill that names an unknown
 * tool could never be offered anywhere, so it is refused before it is stored.
 */
export const validateSkillRequiredTools = (
  metadata: Readonly<Record<string, string>> | null | undefined,
): Result<void, SkillRequiredToolsError> => {
  const required = readSkillRequiredTools(metadata);
  if (required.length > SKILL_REQUIRED_TOOLS_MAX) {
    return Result.err(
      new SkillRequiredToolsError({
        message: `Skill metadata ${SKILL_REQUIRED_TOOLS_METADATA_KEY} lists ${String(required.length)} tools; a skill may require at most ${String(SKILL_REQUIRED_TOOLS_MAX)}.`,
      }),
    );
  }
  const known = skillRequirableToolNames();
  const unknown = required.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    return Result.err(
      new SkillRequiredToolsError({
        message: `Skill metadata ${SKILL_REQUIRED_TOOLS_METADATA_KEY} names tools stella does not have: ${unknown.join(", ")}. List tool names separated by spaces, for example "save_playbook".`,
      }),
    );
  }
  return Result.ok();
};
