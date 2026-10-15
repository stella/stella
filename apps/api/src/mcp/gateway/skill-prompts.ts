import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import type {
  GetPromptResult,
  Prompt,
  PromptMessage,
} from "@modelcontextprotocol/server";

import {
  recordSkillReadAudit,
  SKILL_READ_OUTCOME,
  SKILL_READ_SURFACE,
} from "@/api/lib/agent-skills/skill-read-audit";
import type { McpMode } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import { toDynamicToolTitle } from "@/api/mcp/gateway/list-tools";
import {
  GATEWAY_TOOL_KIND,
  modeAllowsGatewayTools,
} from "@/api/mcp/gateway/mode-policy";
import {
  loadSkillPrompts,
  readSkillTool,
  SKILL_TOOL_READ_TYPE,
} from "@/api/mcp/gateway/skills";
import type { ResolvedSkillTool } from "@/api/mcp/gateway/skills";
import { hasGrantedScope } from "@/api/mcp/gateway/static-tool-visibility";

/**
 * Optional free text the user adds when starting a skill prompt: what to
 * apply the skill to. It rides after the instructions, as a slash command's
 * arguments do in chat.
 */
const SKILL_PROMPT_REQUEST_ARGUMENT = "request";

/**
 * Resource files ride in the prompt as embedded resources, because a
 * `manual` skill has no tool through which the model could read them later.
 * Files past this many characters in total are named but not embedded.
 */
const SKILL_PROMPT_RESOURCE_BUDGET_CHARS = 60_000;

const SKILL_PROMPT_RESOURCE_URI_PREFIX = "stella://skills/";

/**
 * The skills a session serves as prompts. A prompt is started by the user in
 * the client, so this is the MCP surface for `manual` skills; `auto` skills
 * are tools. Gated by the same scope and mode as the skill tools.
 */
export const listSkillPrompts = async ({
  context,
  mode,
  scopes,
}: {
  context: McpRequestContext;
  mode: McpMode;
  scopes: readonly string[] | undefined;
}): Promise<Prompt[]> => {
  if (!servesSkillPrompts({ mode, scopes })) {
    return [];
  }
  return (await loadSkillPrompts({ context, mode, scopes })).map(
    (skill): Prompt => ({
      arguments: [
        {
          description: "What to apply the skill to (optional).",
          name: SKILL_PROMPT_REQUEST_ARGUMENT,
          required: false,
        },
      ],
      description: skill.description,
      name: skill.exposedName,
      title: toDynamicToolTitle(skill.displayName) || skill.exposedName,
    }),
  );
};

/**
 * One skill prompt: the skill's instructions, its resource files embedded up
 * to a budget, and the user's request. Every file read is audited like a
 * skill tool read on the MCP surface. An unknown or no longer available name
 * is an invalid-params protocol error, as for an unknown resource.
 */
export const getSkillPrompt = async ({
  args,
  context,
  mode,
  name,
}: {
  args: Readonly<Record<string, string>> | undefined;
  context: McpRequestContext;
  mode: McpMode;
  name: string;
}): Promise<GetPromptResult> => {
  const skill = servesSkillPrompts({ mode, scopes: context.grantedScopes })
    ? ((
        await loadSkillPrompts({ context, mode, scopes: context.grantedScopes })
      ).find(({ exposedName }) => exposedName === name) ?? null)
    : null;
  if (skill === null) {
    throw unknownPromptError(name);
  }

  const read = await readSkillTool({ context, resourcePath: undefined, skill });
  if (read?.type !== SKILL_TOOL_READ_TYPE.skill) {
    // Disabled or deleted between listing and this read.
    await auditReads({ context, paths: [null], skill, success: false });
    throw unknownPromptError(name);
  }

  const embedded = await embedResources({
    context,
    paths: read.skill.resources.map(({ path }) => path),
    skill,
  });
  await auditReads({
    context,
    paths: [null, ...embedded.read.map(({ path }) => path)],
    skill,
    success: true,
  });

  const request = args?.[SKILL_PROMPT_REQUEST_ARGUMENT]?.trim() ?? "";
  const omitted =
    embedded.omitted.length > 0
      ? `\n\nThese skill files were too large to include: ${embedded.omitted.join(", ")}.`
      : "";
  const requestText = request === "" ? "" : `\n\nMy request:\n${request}`;
  const messages: PromptMessage[] = [
    {
      content: {
        text: `Apply the stella skill "${skill.displayName}" to my request. Its instructions follow; its files are attached.${omitted}\n\n${read.skill.body}${requestText}`,
        type: "text",
      },
      role: "user",
    },
    ...embedded.read.map(({ content, path }): PromptMessage => ({
      content: {
        resource: {
          mimeType: "text/plain",
          text: content,
          uri: `${SKILL_PROMPT_RESOURCE_URI_PREFIX}${encodeURIComponent(skill.name)}/${path}`,
        },
        type: "resource",
      },
      role: "user",
    })),
  ];
  return { description: skill.description, messages };
};

const servesSkillPrompts = ({
  mode,
  scopes,
}: {
  mode: McpMode;
  scopes: readonly string[] | undefined;
}): boolean =>
  hasGrantedScope(scopes, "stella:skills") &&
  modeAllowsGatewayTools(mode, GATEWAY_TOOL_KIND.skill);

const embedResources = async ({
  context,
  paths,
  skill,
}: {
  context: McpRequestContext;
  paths: readonly string[];
  skill: ResolvedSkillTool;
}): Promise<{
  omitted: string[];
  read: { content: string; path: string }[];
}> => {
  const read: { content: string; path: string }[] = [];
  const omitted: string[] = [];
  let remaining = SKILL_PROMPT_RESOURCE_BUDGET_CHARS;
  for (const path of paths) {
    // One file at a time keeps the budget exact; a skill has few files.
    // oxlint-disable-next-line no-await-in-loop -- sequential by design: the budget decides whether the next file is read at all
    const resource = await readSkillTool({
      context,
      resourcePath: path,
      skill,
    });
    if (resource?.type !== SKILL_TOOL_READ_TYPE.resource) {
      continue;
    }
    if (resource.content.length > remaining) {
      omitted.push(path);
      continue;
    }
    remaining -= resource.content.length;
    read.push({ content: resource.content, path });
  }
  return { omitted, read };
};

const auditReads = async ({
  context,
  paths,
  skill,
  success,
}: {
  context: McpRequestContext;
  paths: readonly (string | null)[];
  skill: ResolvedSkillTool;
  success: boolean;
}) =>
  await recordSkillReadAudit({
    reads: paths.map((path) => ({
      outcome: success ? SKILL_READ_OUTCOME.success : SKILL_READ_OUTCOME.error,
      path,
      skill,
      slug: skill.name,
      surface: SKILL_READ_SURFACE.mcp,
    })),
    recordAuditEvent: context.recordAuditEvent,
    safeDb: context.safeDb,
  });

const unknownPromptError = (name: string) =>
  new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown prompt: ${name}`);
