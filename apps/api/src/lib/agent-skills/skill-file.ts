import { SKILL_NAME_PATTERN } from "@stll/skills/format";
import {
  SKILL_INVOCATION_METADATA_KEY,
  type SkillInvocation,
} from "@stll/skills/frontmatter";
import { slugify } from "@stll/text-normalize";

/** The stored columns a SKILL.md file is written from. */
export type StoredSkillFile = {
  body: string;
  compatibility: string | null;
  description: string;
  invocation: SkillInvocation;
  license: string | null;
  metadata: Readonly<Record<string, string>>;
  name: string;
  version: string | null;
};

/** The Agent Skills format's own bound on a name. */
const SKILL_FILE_NAME_MAX_CHARS = 64;

/**
 * The Agent Skills `name` a stored skill is written under. A skill authored
 * in the editor keeps a display name ("Contract review"), which the format
 * does not accept as a name; its slugified form is.
 */
export const skillFileName = (name: string): string =>
  SKILL_NAME_PATTERN.test(name)
    ? name
    : slugify(name, {
        charset: "ascii",
        fallback: "skill",
        maxLength: SKILL_FILE_NAME_MAX_CHARS,
        separator: "-",
      });

// JSON strings are YAML 1.2 double-quoted scalars, so every value, whatever
// characters it holds, is written and read back unchanged.
const scalar = (value: string) => JSON.stringify(value);

/**
 * A stored skill as the SKILL.md file every Agent Skills host reads:
 * frontmatter, then the body. `parseSkillFile` reads it back to the same
 * columns; a `manual` invocation is written the way other hosts spell it.
 */
export const renderSkillFile = (skill: StoredSkillFile): string => {
  const metadata = Object.entries(skill.metadata).filter(
    ([key]) => key !== SKILL_INVOCATION_METADATA_KEY,
  );
  const lines = [
    "---",
    `name: ${scalar(skillFileName(skill.name))}`,
    `description: ${scalar(skill.description)}`,
    ...(skill.version === null ? [] : [`version: ${scalar(skill.version)}`]),
    ...(skill.license === null ? [] : [`license: ${scalar(skill.license)}`]),
    ...(skill.compatibility === null
      ? []
      : [`compatibility: ${scalar(skill.compatibility)}`]),
    ...(skill.invocation === "manual"
      ? ["disable-model-invocation: true"]
      : []),
    ...(metadata.length === 0
      ? []
      : [
          "metadata:",
          ...metadata.map(
            ([key, value]) => `  ${scalar(key)}: ${scalar(value)}`,
          ),
        ]),
    "---",
    "",
    skill.body,
    "",
  ];
  return lines.join("\n");
};
