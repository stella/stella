import { readSkillRequiredTools } from "@stll/skills";

export const SKILL_TOOL_AVAILABILITY_STATUS = {
  available: "available",
  unavailable: "unavailable",
} as const;

export type SkillToolAvailability =
  | { status: typeof SKILL_TOOL_AVAILABILITY_STATUS.available }
  | {
      status: typeof SKILL_TOOL_AVAILABILITY_STATUS.unavailable;
      /** The required tools the context does not offer, in declared order. */
      missingTools: readonly string[];
    };

const AVAILABLE: SkillToolAvailability = {
  status: SKILL_TOOL_AVAILABILITY_STATUS.available,
};

/**
 * The one decision whether a skill can finish in a context: every tool it
 * requires is among the tools that context offers. Each surface supplies its
 * own offered set (a chat turn's registered tools, an MCP session's listed
 * tools); nothing else decides availability.
 */
export const resolveSkillToolAvailability = ({
  metadata,
  offeredToolNames,
}: {
  metadata: Readonly<Record<string, string>> | null | undefined;
  offeredToolNames: ReadonlySet<string>;
}): SkillToolAvailability => {
  const missingTools = readSkillRequiredTools(metadata).filter(
    (name) => !offeredToolNames.has(name),
  );
  return missingTools.length === 0
    ? AVAILABLE
    : { status: SKILL_TOOL_AVAILABILITY_STATUS.unavailable, missingTools };
};

/** Whether any skill in `skills` declares required tools at all. */
export const anySkillRequiresTools = (
  skills: readonly {
    metadata?: Readonly<Record<string, string>> | null | undefined;
  }[],
): boolean =>
  skills.some((skill) => readSkillRequiredTools(skill.metadata).length > 0);

/** One sentence naming what a context lacks, for prompts and error envelopes. */
export const describeMissingSkillTools = (
  missingTools: readonly string[],
): string =>
  `It needs ${missingTools.length === 1 ? "a tool" : "tools"} that ${missingTools.length === 1 ? "is" : "are"} not available here: ${missingTools.join(", ")}.`;

/**
 * The skills a context can offer: those whose required tools it has. The
 * context's tool names are resolved only when some skill requires a tool, so
 * a catalog without requirements costs nothing.
 */
export const filterSkillsWithAvailableTools = <
  TSkill extends {
    metadata?: Readonly<Record<string, string>> | null | undefined;
  },
>({
  offeredToolNames,
  skills,
}: {
  offeredToolNames: () => ReadonlySet<string>;
  skills: readonly TSkill[];
}): TSkill[] => {
  if (!anySkillRequiresTools(skills)) {
    return [...skills];
  }
  const offered = offeredToolNames();
  return skills.filter(
    (skill) =>
      resolveSkillToolAvailability({
        metadata: skill.metadata,
        offeredToolNames: offered,
      }).status === SKILL_TOOL_AVAILABILITY_STATUS.available,
  );
};
