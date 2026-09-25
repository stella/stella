import * as v from "valibot";

import { SKILL_RESOURCE_KINDS } from "@stll/skills/resource-kinds";

import { AGENT_SKILL_ORIGINS } from "@/api/db/schema";
import { LIMITS } from "@/api/lib/limits";
import {
  dynamicToolNamespaceOf,
  type DynamicToolNamespace,
} from "@/api/lib/mcp-upstream/namespace";
import type {
  McpToolAnnotations,
  RuntimeMcpToolOutputContract,
} from "@/api/mcp/tool-types";
import { nullAsAbsent } from "@/api/mcp/tool-utils";
import {
  defineMcpToolInput,
  defineMcpToolOutput,
} from "@/api/mcp/valibot-tool-definition";

export const SKILL_TOOL_OUTPUT_TYPE = {
  resource: "resource",
  skill: "skill",
} as const;

/**
 * The one input contract every `skill__*` tool accepts. Without `resource` a
 * call reads the skill's instructions and the paths of its resource files;
 * with it, one of those files.
 */
export const SKILL_TOOL_INPUT = defineMcpToolInput(
  nullAsAbsent(
    v.strictObject({
      resource: v.optional(
        v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(LIMITS.agentSkillResourcePathMaxChars),
          v.description(
            "Path of one resource file to read, copied from `resources` " +
              "in this tool's answer without `resource`. Omit to read the " +
              "skill's instructions and its list of resource paths.",
          ),
        ),
      ),
    }),
  ),
);

const skillIdSchema = v.pipe(
  v.string(),
  v.uuid(),
  v.description("Stored skill id"),
);
const skillNameSchema = v.pipe(v.string(), v.description("Skill slug"));
const resourceKindSchema = v.pipe(
  v.picklist(SKILL_RESOURCE_KINDS),
  v.description("What the resource file holds"),
);

/**
 * The one output contract every `skill__*` tool serves. Skill tools differ
 * only by which stored skill they return, so the contract is shared by the
 * family rather than keyed by a generated, tenant-specific tool name.
 */
const SKILL_TOOL_OUTPUT_SCHEMA = v.variant("type", [
  v.strictObject({
    type: v.literal(SKILL_TOOL_OUTPUT_TYPE.skill),
    body: v.pipe(
      v.string(),
      v.description("Skill instructions (Markdown) to follow for this task"),
    ),
    compatibility: v.pipe(
      v.nullable(v.string()),
      v.description("Declared compatibility range, if any"),
    ),
    id: skillIdSchema,
    license: v.pipe(v.nullable(v.string()), v.description("Skill license")),
    metadata: v.pipe(
      v.record(v.string(), v.string()),
      v.description("Author-declared string metadata"),
    ),
    name: skillNameSchema,
    origin: v.pipe(
      v.picklist(AGENT_SKILL_ORIGINS),
      v.description("How the skill entered the workspace"),
    ),
    resources: v.pipe(
      v.array(
        v.strictObject({
          kind: resourceKindSchema,
          path: v.pipe(
            v.string(),
            v.description("Pass as `resource` to read this file"),
          ),
        }),
      ),
      v.description("Resource files the instructions may rely on"),
    ),
    version: v.pipe(
      v.nullable(v.string()),
      v.description("Skill version, if declared"),
    ),
  }),
  v.strictObject({
    type: v.literal(SKILL_TOOL_OUTPUT_TYPE.resource),
    content: v.pipe(v.string(), v.description("The resource file's text")),
    id: skillIdSchema,
    kind: resourceKindSchema,
    name: skillNameSchema,
    path: v.pipe(v.string(), v.description("The resource file's path")),
  }),
]);

export type SkillToolOutput = v.InferInput<typeof SKILL_TOOL_OUTPUT_SCHEMA>;

export const SKILL_TOOL_OUTPUT = defineMcpToolOutput(SKILL_TOOL_OUTPUT_SCHEMA);

/**
 * Invoking a skill tool reads stored instructions and metadata from the
 * caller's own workspace: nothing is written and no external system is
 * contacted, so the family is read-only, non-destructive and closed-world.
 */
export const SKILL_TOOL_ANNOTATIONS = {
  destructiveHint: false,
  openWorldHint: false,
  readOnlyHint: true,
} as const satisfies Omit<McpToolAnnotations, "title">;

type DynamicToolFamilyPolicy =
  | {
      owner: "stella";
      annotations: typeof SKILL_TOOL_ANNOTATIONS;
      output: RuntimeMcpToolOutputContract;
    }
  /**
   * A third-party connector's tools keep the contract their upstream server
   * declared. The gateway relays upstream output as text only and never lands
   * an upstream shape in `structuredContent`, so no output schema is
   * advertised on its behalf.
   */
  | { owner: "upstream" };

/**
 * One policy per dynamic tool family. Total over the namespace census, so a
 * new family cannot be namespaced without deciding who owns its contract.
 */
export const DYNAMIC_TOOL_FAMILY_POLICIES = {
  external_mcp: { owner: "upstream" },
  skill: {
    owner: "stella",
    annotations: SKILL_TOOL_ANNOTATIONS,
    output: SKILL_TOOL_OUTPUT,
  },
} as const satisfies Record<DynamicToolNamespace, DynamicToolFamilyPolicy>;

/** Families whose tools serve a Stella contract; derived, never listed twice. */
export type StellaOwnedDynamicToolNamespace = {
  [
    TNamespace in DynamicToolNamespace
  ]: (typeof DYNAMIC_TOOL_FAMILY_POLICIES)[TNamespace] extends {
    owner: "stella";
  }
    ? TNamespace
    : never;
}[DynamicToolNamespace];

export const isStellaOwnedDynamicToolNamespace = (
  namespace: DynamicToolNamespace,
): namespace is StellaOwnedDynamicToolNamespace =>
  DYNAMIC_TOOL_FAMILY_POLICIES[namespace].owner === "stella";

export const getDynamicMcpToolOutputContract = (
  toolName: string,
): RuntimeMcpToolOutputContract | undefined => {
  const namespace = dynamicToolNamespaceOf(toolName);
  if (namespace === undefined) {
    return undefined;
  }
  const policy = DYNAMIC_TOOL_FAMILY_POLICIES[namespace];
  return policy.owner === "stella" ? policy.output : undefined;
};
