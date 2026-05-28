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

  return {
    "load-skill": tool({
      description:
        "Load the full instructions for one Stella skill. The system " +
        "prompt lists skill names and descriptions only; use this when " +
        "a skill is relevant to the user's task and you need its full " +
        "methodology or resource list.",
      inputSchema: valibotSchema(
        v.strictObject({
          skillName: v.pipe(
            v.string(),
            v.description(
              "Skill name exactly as listed in the chat skill catalog.",
            ),
          ),
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
          skillName: v.pipe(
            v.string(),
            v.description(
              "Skill name exactly as listed in the chat skill catalog.",
            ),
          ),
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

        const read = await readSkillResourceContent({
          organizationId,
          path,
          safeDb,
          skillName,
          userId,
        });
        return {
          skillName,
          path,
          mimeType: inferSkillResourceMimeType(path),
          content: read.content,
          skillId: read.skillId,
          origin: read.origin,
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

const SKILL_RESOURCE_MIME_BY_EXT: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  pdf: "application/pdf",
};

const inferSkillResourceMimeType = (path: string): string => {
  const filename = path.split("/").pop() ?? "";
  const lastDot = filename.lastIndexOf(".");
  if (lastDot === -1) {
    return "text/plain";
  }
  const ext = filename.slice(lastDot + 1).toLowerCase();
  return SKILL_RESOURCE_MIME_BY_EXT[ext] ?? "text/plain";
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
