/**
 * Frontmatter `metadata` key under which a skill names the tools it cannot
 * finish without. The Agent Skills spec reserves `metadata` for host
 * extensions; the value follows the `allowed-tools` spelling: tool names
 * separated by whitespace (`stella-required-tools: save_playbook`).
 */
export const SKILL_REQUIRED_TOOLS_METADATA_KEY = "stella-required-tools";

/** How many tools one skill may require. */
export const SKILL_REQUIRED_TOOLS_MAX = 8;

/**
 * The tools a skill declares it needs, deduplicated, in declared order.
 * Empty when the key is absent or blank. Names are not checked here: the host
 * validates them against its tool registry when the skill is saved.
 */
export const readSkillRequiredTools = (
  metadata: Readonly<Record<string, string>> | null | undefined,
): readonly string[] => {
  const value = metadata?.[SKILL_REQUIRED_TOOLS_METADATA_KEY];
  if (value === undefined) {
    return [];
  }
  return [...new Set(value.split(/\s+/u).filter((name) => name.length > 0))];
};
