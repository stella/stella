import { toolDefinition } from "@tanstack/ai";
import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import type { SkillMetadata } from "@stll/skills";

import type { SafeDb } from "@/api/db/safe-db";
import { agentSkillResources, agentSkills } from "@/api/db/schema";
import type { AgentSkillOrigin } from "@/api/db/schema";
import { hashAuthoredSkillContent } from "@/api/handlers/skills/authored-content-hash";
import {
  RESOURCE_PATH_PATTERN,
  inferResourceKind,
} from "@/api/lib/agent-skills/resource-path";
import {
  ACTIVE_SKILL_BODY_PROMPT_MAX_CHARS,
  type ActiveChatSkillContext,
  listAvailableChatSkillResources,
  loadAvailableChatSkill,
  readAvailableChatSkillResource,
} from "@/api/lib/agent-skills/skills";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { toTanStackValibotSchema as toTanStackToolSchema } from "@/api/lib/tanstack-ai-schema";

type AvailableSkillMetadata = SkillMetadata & {
  source?: "built-in" | "installed" | undefined;
};

type CreateSkillToolsProps = {
  activeSkillContext?: ActiveChatSkillContext | null | undefined;
  organizationId: SafeId<"organization">;
  recordAuditEvent?: AuditRecorder | undefined;
  safeDb: SafeDb;
  skills: readonly AvailableSkillMetadata[];
  userId: SafeId<"user">;
};

export const createSkillTools = ({
  activeSkillContext,
  organizationId,
  recordAuditEvent,
  safeDb,
  skills,
  userId,
}: CreateSkillToolsProps) => {
  const availableSkillIds = new Set(skills.map((skill) => skill.name));
  const activeSkillId = activeSkillContext?.id ?? undefined;
  const activeEditableSkillContext =
    toActiveEditableSkillContext(activeSkillContext);
  const currentSkillEditTools =
    activeEditableSkillContext && recordAuditEvent !== undefined
      ? createCurrentSkillEditTools({
          activeSkillContext: activeEditableSkillContext,
          organizationId,
          recordAuditEvent,
          safeDb,
        })
      : {};

  if (skills.length === 0) {
    return {
      "load-skill": undefined,
      "read-skill-resource": undefined,
      ...currentSkillEditTools,
    };
  }

  const skillNameSchema = createSkillNameSchema(skills);

  return {
    "load-skill": toolDefinition({
      name: "load-skill",
      description:
        "Load the full instructions for one stella skill. The system " +
        "prompt lists skill names and descriptions only; use this when " +
        "a skill is relevant to the user's task and you need its full " +
        "methodology or resource list.",
      inputSchema: toTanStackToolSchema(
        v.strictObject({
          skillName: skillNameSchema,
        }),
      ),
    }).server(async ({ skillName }) => {
      assertAvailableSkill({
        availableSkillIds,
        skillName,
      });

      const skillResult = await loadAvailableChatSkill({
        activeSkillId,
        organizationId,
        safeDb,
        skillName,
        userId,
      });
      if (Result.isError(skillResult)) {
        throw new ChatToolError({
          kind: "server-defect",
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
    }),

    "read-skill-resource": toolDefinition({
      name: "read-skill-resource",
      description:
        "Read one resource from a loaded stella skill. Use only paths " +
        "returned by load-skill. Resources are read-only methodology, " +
        "knowledge, or prompt templates; they do not grant access to " +
        "matter data.",
      inputSchema: toTanStackToolSchema(
        v.strictObject({
          skillName: skillNameSchema,
          path: v.pipe(
            v.string(),
            v.description(
              "Resource path from load-skill, such as knowledge/01-example.md.",
            ),
          ),
        }),
      ),
    }).server(async ({ path, skillName }) => {
      assertAvailableSkill({
        availableSkillIds,
        skillName,
      });

      const resourcesResult = await listAvailableChatSkillResources({
        activeSkillId,
        organizationId,
        safeDb,
        skillName,
        userId,
      });
      if (Result.isError(resourcesResult)) {
        throw new ChatToolError({
          kind: "server-defect",
          message: "Skill resources could not be listed.",
          cause: resourcesResult.error,
        });
      }

      const resources = resourcesResult.value;
      if (!resources.some((resource) => resource.path === path)) {
        throw new ChatToolError({
          kind: "not-found",
          message: "Unknown or unavailable skill resource path.",
        });
      }

      const read = await readSkillResourceContent({
        activeSkillId,
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
    }),

    ...currentSkillEditTools,
  };
};

const SKILL_NAME_DESCRIPTION =
  "Skill name exactly as listed in the chat skill catalog.";

const createSkillNameSchema = (skills: readonly AvailableSkillMetadata[]) => {
  // Installed names are user-controlled and can contain privileged matter
  // context. They stay out of provider-visible JSON Schema; the runtime
  // availability check remains authoritative for mixed catalogs. A catalog
  // containing only built-in public names can make invalid calls impossible
  // at the provider boundary with an exact enum.
  if (skills.some((skill) => skill.source === "installed")) {
    return v.pipe(v.string(), v.description(SKILL_NAME_DESCRIPTION));
  }

  const skillNames = skills.map((skill) => skill.name);
  const firstSkillName = skillNames.at(0);
  if (firstSkillName === undefined) {
    return v.pipe(v.string(), v.description(SKILL_NAME_DESCRIPTION));
  }

  return v.pipe(
    v.picklist([firstSkillName, ...skillNames.slice(1)]),
    v.description(SKILL_NAME_DESCRIPTION),
  );
};

const readSkillResourceContent = async ({
  activeSkillId,
  organizationId,
  path,
  safeDb,
  skillName,
  userId,
}: {
  activeSkillId?: SafeId<"agentSkill"> | undefined;
  organizationId: SafeId<"organization">;
  path: string;
  safeDb: SafeDb;
  skillName: string;
  userId: SafeId<"user">;
}) => {
  const resourceResult = await readAvailableChatSkillResource({
    activeSkillId,
    organizationId,
    path,
    safeDb,
    skillName,
    userId,
  });
  if (Result.isError(resourceResult)) {
    throw new ChatToolError({
      kind: "server-defect",
      message: "Skill resource could not be read.",
      cause: resourceResult.error,
    });
  }
  return resourceResult.value;
};

type ActiveEditableSkillContext = ActiveChatSkillContext & {
  editable: true;
  id: SafeId<"agentSkill">;
  origin: AgentSkillOrigin;
};

const toActiveEditableSkillContext = (
  activeSkillContext: ActiveChatSkillContext | null | undefined,
): ActiveEditableSkillContext | null => {
  if (
    activeSkillContext?.editable === true &&
    activeSkillContext.id !== null &&
    activeSkillContext.origin !== "built-in" &&
    activeSkillContext.origin !== "bundled"
  ) {
    return {
      ...activeSkillContext,
      editable: true,
      id: activeSkillContext.id,
      origin: activeSkillContext.origin,
    };
  }

  return null;
};

type CurrentSkillEditToolsContext = {
  activeSkillContext: ActiveEditableSkillContext;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
};

const createCurrentSkillEditTools = ({
  activeSkillContext,
  organizationId,
  recordAuditEvent,
  safeDb,
}: CurrentSkillEditToolsContext) => {
  const bodyReplacementTools = canReplaceCurrentSkillBody(activeSkillContext)
    ? {
        "update-current-skill-body": toolDefinition({
          name: "update-current-skill-body",
          description:
            "Replace the current active skill's SKILL.md body. This tool is " +
            "only available in a chat opened from an editable skill. Use it " +
            "only when the user asks to edit the current skill instructions.",
          inputSchema: toTanStackToolSchema(
            v.strictObject({
              content: v.pipe(
                v.string(),
                v.minLength(1),
                v.maxLength(LIMITS.agentSkillBodyMaxChars),
                v.description("Full replacement markdown body for SKILL.md."),
              ),
            }),
          ),
        }).server(
          async ({ content }) =>
            await updateCurrentSkillBody({
              activeSkillContext,
              content,
              recordAuditEvent,
              safeDb,
            }),
        ),
      }
    : {};

  return {
    ...bodyReplacementTools,

    "update-current-skill-resource": toolDefinition({
      name: "update-current-skill-resource",
      description:
        "Replace one existing file in the current active skill. This tool " +
        "is only available in a chat opened from an editable skill. Use " +
        "paths from the active skill file list or read-skill-resource.",
      inputSchema: toTanStackToolSchema(
        v.strictObject({
          path: v.pipe(
            v.string(),
            v.minLength(1),
            v.maxLength(512),
            v.description("Existing resource path inside the current skill."),
          ),
          content: v.pipe(
            v.string(),
            v.maxLength(LIMITS.agentSkillResourceMaxChars),
            v.description("Full replacement text content for the resource."),
          ),
        }),
      ),
    }).server(
      async ({ content, path }) =>
        await updateCurrentSkillResource({
          activeSkillContext,
          content,
          path,
          recordAuditEvent,
          safeDb,
        }),
    ),

    "create-current-skill-resource": toolDefinition({
      name: "create-current-skill-resource",
      description:
        "Create a new text/markdown file in the current active skill. " +
        "This tool is only available in a chat opened from an editable skill.",
      inputSchema: toTanStackToolSchema(
        v.strictObject({
          path: v.pipe(
            v.string(),
            v.minLength(1),
            v.maxLength(512),
            v.description(
              "New resource path inside the current skill, such as knowledge/checklist.md.",
            ),
          ),
          content: v.pipe(
            v.string(),
            v.maxLength(LIMITS.agentSkillResourceMaxChars),
            v.description("Text content for the new resource."),
          ),
        }),
      ),
    }).server(
      async ({ content, path }) =>
        await createCurrentSkillResource({
          activeSkillContext,
          content,
          organizationId,
          path,
          recordAuditEvent,
          safeDb,
        }),
    ),
  };
};

const canReplaceCurrentSkillBody = (
  activeSkillContext: ActiveEditableSkillContext,
) => activeSkillContext.body.length <= ACTIVE_SKILL_BODY_PROMPT_MAX_CHARS;

type UpdateCurrentSkillBodyProps = {
  activeSkillContext: ActiveEditableSkillContext;
  content: string;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
};

const updateCurrentSkillBody = async ({
  activeSkillContext,
  content,
  recordAuditEvent,
  safeDb,
}: UpdateCurrentSkillBodyProps) => {
  const result = await safeDb(
    async (tx) =>
      await tx.transaction(async (innerTx) => {
        const currentRows = await innerTx
          .select({
            name: agentSkills.name,
            description: agentSkills.description,
            version: agentSkills.version,
          })
          .from(agentSkills)
          .where(eq(agentSkills.id, activeSkillContext.id))
          .limit(1)
          .for("update");
        const current = currentRows.at(0);
        if (current === undefined) {
          panic("active skill vanished during body update");
        }
        // The content hash covers the body, so a body-only write must refresh
        // it: the revision trigger snapshots whatever hash the row carries.
        await innerTx
          .update(agentSkills)
          .set({
            body: content,
            contentHash: hashAuthoredSkillContent({
              body: content,
              description: current.description,
              name: current.name,
              version: current.version,
            }),
          })
          .where(eq(agentSkills.id, activeSkillContext.id));

        await recordAuditEvent(innerTx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.AGENT_SKILL,
          resourceId: activeSkillContext.id,
          changes: {
            body: {
              old: activeSkillContext.body,
              new: content,
            },
          },
          metadata: { slug: activeSkillContext.toolName },
        });
      }),
  );
  if (Result.isError(result)) {
    throw new ChatToolError({
      kind: "server-defect",
      message: "Current skill body could not be updated.",
      cause: result.error,
    });
  }

  return formatCurrentSkillFileOutput({
    activeSkillContext,
    content,
    path: "SKILL.md",
    target: "body",
  });
};

type UpdateCurrentSkillResourceProps = {
  activeSkillContext: ActiveEditableSkillContext;
  content: string;
  path: string;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
};

const updateCurrentSkillResource = async ({
  activeSkillContext,
  content,
  path,
  recordAuditEvent,
  safeDb,
}: UpdateCurrentSkillResourceProps) => {
  const activeResource = activeSkillContext.resources.find(
    (resource) => resource.path === path,
  );
  if (!activeResource) {
    throw new ChatToolError({
      kind: "not-found",
      message: "Resource is not part of the current active skill.",
    });
  }

  const existingResource = await safeDb((tx) =>
    tx
      .select({
        id: agentSkillResources.id,
        path: agentSkillResources.path,
        sizeBytes: agentSkillResources.sizeBytes,
      })
      .from(agentSkillResources)
      .where(
        and(
          eq(agentSkillResources.skillId, activeSkillContext.id),
          eq(agentSkillResources.path, path),
        ),
      )
      .limit(1),
  );
  if (Result.isError(existingResource)) {
    throw new ChatToolError({
      kind: "server-defect",
      message: "Current skill resource could not be loaded.",
      cause: existingResource.error,
    });
  }
  const row = existingResource.value.at(0);
  if (!row) {
    throw new ChatToolError({
      kind: "not-found",
      message: "Resource is not part of the current active skill.",
    });
  }

  const nextSizeBytes = new TextEncoder().encode(content).byteLength;
  const result = await safeDb(
    async (tx) =>
      await tx.transaction(async (innerTx) => {
        await innerTx
          .update(agentSkillResources)
          .set({ content, sizeBytes: nextSizeBytes })
          .where(eq(agentSkillResources.id, row.id));

        await recordAuditEvent(innerTx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.AGENT_SKILL,
          resourceId: activeSkillContext.id,
          changes: {
            resource: {
              old: { path: row.path, sizeBytes: row.sizeBytes },
              new: { path: row.path, sizeBytes: nextSizeBytes },
            },
          },
          metadata: { slug: activeSkillContext.toolName, path: row.path },
        });
      }),
  );
  if (Result.isError(result)) {
    throw new ChatToolError({
      kind: "server-defect",
      message: "Current skill resource could not be updated.",
      cause: result.error,
    });
  }

  return formatCurrentSkillFileOutput({
    activeSkillContext,
    content,
    path: activeResource.path,
    target: "resource",
  });
};

type CreateCurrentSkillResourceProps = {
  activeSkillContext: ActiveEditableSkillContext;
  content: string;
  organizationId: SafeId<"organization">;
  path: string;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
};

const createCurrentSkillResource = async ({
  activeSkillContext,
  content,
  organizationId,
  path,
  recordAuditEvent,
  safeDb,
}: CreateCurrentSkillResourceProps) => {
  const trimmedPath = path.trim();
  if (!RESOURCE_PATH_PATTERN.test(trimmedPath)) {
    throw new ChatToolError({
      kind: "invalid-input",
      message: "Invalid resource path.",
    });
  }

  const existingCount = await safeDb((tx) =>
    tx.$count(
      agentSkillResources,
      eq(agentSkillResources.skillId, activeSkillContext.id),
    ),
  );
  if (Result.isError(existingCount)) {
    throw new ChatToolError({
      kind: "server-defect",
      message: "Current skill files could not be counted.",
      cause: existingCount.error,
    });
  }
  if (existingCount.value >= LIMITS.agentSkillResourcesPerSkill) {
    throw new ChatToolError({
      kind: "limit",
      message: "Skill has reached the maximum number of files.",
    });
  }

  const duplicateCount = await safeDb((tx) =>
    tx.$count(
      agentSkillResources,
      and(
        eq(agentSkillResources.skillId, activeSkillContext.id),
        eq(agentSkillResources.path, trimmedPath),
      ),
    ),
  );
  if (Result.isError(duplicateCount)) {
    throw new ChatToolError({
      kind: "server-defect",
      message: "Current skill files could not be checked.",
      cause: duplicateCount.error,
    });
  }
  if (duplicateCount.value > 0) {
    throw new ChatToolError({
      kind: "invalid-input",
      message: "File already exists.",
    });
  }

  const kind = inferResourceKind(trimmedPath);
  const sizeBytes = new TextEncoder().encode(content).byteLength;
  const result = await safeDb(
    async (tx) =>
      await tx.transaction(async (innerTx) => {
        const rows = await innerTx
          .insert(agentSkillResources)
          .values({
            organizationId,
            skillId: activeSkillContext.id,
            path: trimmedPath,
            kind,
            content,
            sizeBytes,
          })
          .returning({ id: agentSkillResources.id });
        const row = rows.at(0);
        if (row) {
          await recordAuditEvent(innerTx, {
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.AGENT_SKILL,
            resourceId: activeSkillContext.id,
            changes: {
              resource: {
                old: null,
                new: { path: trimmedPath, kind, sizeBytes },
              },
            },
            metadata: {
              slug: activeSkillContext.toolName,
              path: trimmedPath,
            },
          });
        }

        return row ?? null;
      }),
  );
  if (Result.isError(result)) {
    throw new ChatToolError({
      kind: "server-defect",
      message: "Current skill resource could not be created.",
      cause: result.error,
    });
  }
  if (!result.value) {
    throw new ChatToolError({
      kind: "server-defect",
      message: "Current skill resource could not be created.",
    });
  }

  return formatCurrentSkillFileOutput({
    activeSkillContext,
    content,
    path: trimmedPath,
    target: "resource",
  });
};

type CurrentSkillFileOutputProps = {
  activeSkillContext: ActiveEditableSkillContext;
  content: string;
  path: string;
  target: "body" | "resource";
};

const formatCurrentSkillFileOutput = ({
  activeSkillContext,
  content,
  path,
  target,
}: CurrentSkillFileOutputProps) => ({
  skillName: activeSkillContext.toolName,
  path,
  content,
  mimeType: inferSkillResourceMimeType(path),
  skillId: activeSkillContext.id,
  origin: activeSkillContext.origin,
  target,
});

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
      kind: "not-found",
      message:
        `No skill named "${skillName}" is available in this chat context. ` +
        "Continue without it or choose an exact name from the skill catalog.",
    });
  }
};
