import { valibotSchema } from "@ai-sdk/valibot";
import type { SkillMetadata } from "@stll/skills";
import { listSkillResources, loadSkill, readSkillResource } from "@stll/skills";
// oxlint-disable-next-line no-restricted-imports
import { tool } from "ai";
import * as v from "valibot";

import { ChatToolError } from "@/api/lib/errors/tagged-errors";

type CreateSkillToolsProps = {
  skills: readonly SkillMetadata[];
};

export const createSkillTools = ({ skills }: CreateSkillToolsProps) => {
  const availableSkillIds = new Set(skills.map((skill) => skill.name));
  const allowedSkillDescription = `Available skill names: ${[...availableSkillIds].join(", ")}`;

  return {
    "load-skill": tool({
      description:
        "Load the full instructions for one Stella skill. The system " +
        "prompt lists skill names and descriptions only; use this when " +
        "a skill is relevant to the user's task and you need its full " +
        "methodology or resource list.",
      inputSchema: valibotSchema(
        v.strictObject({
          skillName: v.pipe(v.string(), v.description(allowedSkillDescription)),
        }),
      ),
      // eslint-disable-next-line require-await
      execute: async ({ skillName }) => {
        assertAvailableSkill({
          availableSkillIds,
          skillName,
        });

        const skill = loadSkill(skillName);
        return {
          name: skill.name,
          version: skill.version,
          description: skill.description,
          instructions: skill.body,
          resources: skill.resources,
        };
      },
    }),

    "read-skill-resource": tool({
      description:
        "Read one resource from a loaded Stella skill. Use only paths " +
        "returned by load-skill. Resources are read-only methodology, " +
        "knowledge, or prompt templates; they do not grant access to " +
        "matter data.",
      inputSchema: valibotSchema(
        v.strictObject({
          skillName: v.pipe(v.string(), v.description(allowedSkillDescription)),
          path: v.pipe(
            v.string(),
            v.description(
              "Resource path from load-skill, such as knowledge/01-example.md.",
            ),
          ),
        }),
      ),
      // eslint-disable-next-line require-await
      execute: async ({ path, skillName }) => {
        assertAvailableSkill({
          availableSkillIds,
          skillName,
        });

        const resources = listSkillResources(skillName);
        if (!resources.some((resource) => resource.path === path)) {
          throw new ChatToolError({
            message: "Unknown or unavailable skill resource path.",
          });
        }

        return {
          skillName,
          path,
          content: readSkillResource({
            resourcePath: path,
            skillId: skillName,
          }),
        };
      },
    }),
  };
};

const assertAvailableSkill = ({
  availableSkillIds,
  skillName,
}: {
  availableSkillIds: ReadonlySet<string>;
  skillName: string;
}) => {
  if (!availableSkillIds.has(skillName)) {
    throw new ChatToolError({
      message: `Skill is not available in this chat context: ${skillName}`,
    });
  }
};
