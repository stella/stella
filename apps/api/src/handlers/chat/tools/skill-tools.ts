import { valibotSchema } from "@ai-sdk/valibot";
import { tool } from "ai";
import { Result } from "better-result";
import * as v from "valibot";

import type { SkillMetadata } from "@stll/skills";

import type { SafeDb } from "@/api/db";
import {
  listAvailableChatSkillResources,
  loadAvailableChatSkill,
  readAvailableChatSkillResource,
} from "@/api/handlers/chat/skills";
import type { SafeId } from "@/api/lib/branded-types";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";

type CreateSkillToolsProps = {
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  skills: readonly SkillMetadata[];
  userId: SafeId<"user">;
};

export const createSkillTools = ({
  organizationId,
  safeDb,
  skills,
  userId,
}: CreateSkillToolsProps) => {
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
      execute: async ({ skillName }) => {
        assertAvailableSkill({
          availableSkillIds,
          skillName,
        });

        const skillResult = await loadAvailableChatSkill({
          organizationId,
          safeDb,
          skillName,
          userId,
        });
        if (Result.isError(skillResult)) {
          throw new ChatToolError({
            message: "Skill could not be loaded.",
            cause: skillResult.error,
          });
        }
        const skill = skillResult.value;
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
      execute: async ({ path, skillName }) => {
        assertAvailableSkill({
          availableSkillIds,
          skillName,
        });

        const resourcesResult = await listAvailableChatSkillResources({
          organizationId,
          safeDb,
          skillName,
          userId,
        });
        if (Result.isError(resourcesResult)) {
          throw new ChatToolError({
            message: "Skill resources could not be listed.",
            cause: resourcesResult.error,
          });
        }

        const resources = resourcesResult.value;
        if (!resources.some((resource) => resource.path === path)) {
          throw new ChatToolError({
            message: "Unknown or unavailable skill resource path.",
          });
        }

        return {
          skillName,
          path,
          content: await readSkillResourceContent({
            organizationId,
            path,
            safeDb,
            skillName,
            userId,
          }),
        };
      },
    }),
  };
};

const readSkillResourceContent = async ({
  organizationId,
  path,
  safeDb,
  skillName,
  userId,
}: {
  organizationId: SafeId<"organization">;
  path: string;
  safeDb: SafeDb;
  skillName: string;
  userId: SafeId<"user">;
}) => {
  const resourceResult = await readAvailableChatSkillResource({
    organizationId,
    path,
    safeDb,
    skillName,
    userId,
  });
  if (Result.isError(resourceResult)) {
    throw new ChatToolError({
      message: "Skill resource could not be read.",
      cause: resourceResult.error,
    });
  }
  return resourceResult.value;
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
