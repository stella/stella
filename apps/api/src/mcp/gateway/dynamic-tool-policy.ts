import * as v from "valibot";

import { AGENT_SKILL_ORIGINS } from "@/api/db/schema";
import {
  dynamicToolNamespaceOf,
  type DynamicToolNamespace,
} from "@/api/lib/mcp-upstream/namespace";
import type {
  McpToolAnnotations,
  RuntimeMcpToolOutputContract,
} from "@/api/mcp/tool-types";
import { defineMcpToolOutput } from "@/api/mcp/valibot-tool-definition";

/**
 * The one output contract every `skill__*` tool serves. Skill tools differ
 * only by which stored skill they return, so the contract is shared by the
 * family rather than keyed by a generated, tenant-specific tool name.
 */
const SKILL_TOOL_OUTPUT_SCHEMA = v.strictObject({
  body: v.pipe(
    v.string(),
    v.description("Skill instructions (Markdown) to follow for this task"),
  ),
  compatibility: v.pipe(
    v.nullable(v.string()),
    v.description("Declared compatibility range, if any"),
  ),
  license: v.pipe(v.nullable(v.string()), v.description("Skill license")),
  metadata: v.pipe(
    v.record(v.string(), v.string()),
    v.description("Author-declared string metadata"),
  ),
  name: v.pipe(v.string(), v.description("Skill slug")),
  origin: v.pipe(
    v.picklist(AGENT_SKILL_ORIGINS),
    v.description("How the skill entered the workspace"),
  ),
  version: v.pipe(
    v.nullable(v.string()),
    v.description("Skill version, if declared"),
  ),
});

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
  [TNamespace in DynamicToolNamespace]: (typeof DYNAMIC_TOOL_FAMILY_POLICIES)[TNamespace] extends {
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
