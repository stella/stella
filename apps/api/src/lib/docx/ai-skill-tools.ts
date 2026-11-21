import { maxIterations } from "@tanstack/ai";
/**
 * Wires stella `load-skill` / `read-skill-resource` tools into the one-shot
 * template field generators when (and only when) a field's AI instruction
 * references a skill via the canonical `[label](#stella-skill-ref=slug)`
 * markdown link the prompt inputs emit.
 *
 * The chat composer resolves these refs through a multi-step tool loop; the
 * field generators are otherwise single-shot, so without this they would treat
 * a skill ref as inert text. Detecting a ref and attaching the reusable
 * `createSkillTools` set lets the model load the referenced methodology before
 * drafting the value, while a ref-free prompt keeps the old no-tools path.
 *
 * Reusable beyond the docx generators: the extraction (properties) generators
 * can adopt the same `maybeSkillTools` seam later without changing this module.
 */
import { Result } from "better-result";

import { SKILL_REF_HREF_PREFIX } from "@stll/api-contract";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { NO_SKILL_BINDING_SCOPE } from "@/api/lib/agent-skills/binding";
import { offerSkillsToModel } from "@/api/lib/agent-skills/invocation";
import { filterSkillsWithAvailableTools } from "@/api/lib/agent-skills/required-tools";
import { extractSkillRefSlugs } from "@/api/lib/agent-skills/skill-refs";
import { createSkillTools } from "@/api/lib/agent-skills/skill-tools";
import { listAvailableChatSkillMetadata } from "@/api/lib/agent-skills/skills";
import type { SafeId } from "@/api/lib/branded-types";
import {
  type ChatToolMap,
  chatToolMapToArray,
} from "@/api/lib/chat/chat-tool-types";
import { type FailureSink, failureSink } from "@/api/lib/observability/failure";

/** Server-validated identity the skill tools resolve skills against. */
export type SkillToolsContext = {
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  userId: SafeId<"user">;
};

/**
 * Returns the `load-skill` + `read-skill-resource` tool set when `prompt`
 * references at least one skill in the catalog, otherwise `undefined` so the
 * caller keeps its existing no-tools behaviour. The catalog is the one chat
 * serves: the caller's enabled team and private skills and the built-ins,
 * private first on a slug collision. `ctx` is omitted at boundaries that
 * cannot wire the skill identity; in that case skill refs stay inert (no
 * tools).
 */
export const maybeSkillTools = async (
  prompt: string,
  ctx: SkillToolsContext | undefined,
): Promise<Result<ChatToolMap | undefined, SafeDbError>> => {
  if (ctx === undefined) {
    return Result.ok(undefined);
  }
  const referencedSlugs = new Set(extractSkillRefSlugs(prompt));
  if (referencedSlugs.size === 0) {
    return Result.ok(undefined);
  }
  // A field generator has no conversation matter: unbound skills only.
  const listed = await listAvailableChatSkillMetadata({
    ...ctx,
    bindingScope: NO_SKILL_BINDING_SCOPE,
  });
  if (Result.isError(listed)) {
    return Result.err(listed.error);
  }
  // A one-shot generator offers no tool besides the skill reads, so a skill
  // that requires any tool cannot finish here and is not offered. The refs in
  // the instruction are its author's explicit invocation; any other `manual`
  // skill stays out of the model's reach.
  const skills = offerSkillsToModel({
    invokedSkillNames: referencedSlugs,
    skills: filterSkillsWithAvailableTools({
      offeredToolNames: () => new Set(),
      skills: listed.value,
    }),
  });
  if (!skills.some(({ name }) => referencedSlugs.has(name))) {
    return Result.ok(undefined);
  }
  return Result.ok(
    createSkillTools({
      bindingScope: NO_SKILL_BINDING_SCOPE,
      organizationId: ctx.organizationId,
      safeDb: ctx.safeDb,
      skills,
      userId: ctx.userId,
    }),
  );
};

/**
 * One-shot guidance equivalent to chat's POST-LOAD-SKILL rule: load the
 * referenced skill, apply its methodology to the field, and return only the
 * field value — never a "loaded the skill" confirmation.
 */
export const SKILL_REF_GENERATOR_GUIDANCE =
  "If the instruction contains a markdown link of the form " +
  `[label](${SKILL_REF_HREF_PREFIX}slug), call load-skill with that slug first, ` +
  "then apply the skill's methodology to draft this field. Do not narrate " +
  "loading the skill; return only the field value.";

const CONDITION_SKILL_MAX_STEPS = 4;

export const conditionSkillCapability = (prompt: string) =>
  extractSkillRefSlugs(prompt).length > 0
    ? { requiredCapability: "tools" as const }
    : {};

/** Fill and preview must expose the same skill reads and capability requirement. */
export const prepareConditionSkills = async (
  prompt: string,
  context: SkillToolsContext | undefined,
) => {
  const tools = await maybeSkillTools(prompt, context);
  if (Result.isError(tools)) {
    return Result.err(tools.error);
  }
  return Result.ok({
    question: conditionSkillCapability(prompt),
    generation:
      tools.value === undefined
        ? {}
        : {
            system: SKILL_REF_GENERATOR_GUIDANCE,
            tools: chatToolMapToArray(tools.value),
            agentLoopStrategy: maxIterations(CONDITION_SKILL_MAX_STEPS),
          },
  });
};

// Loading the caller's skill catalog failed before any model call, so it is a
// database failure of this adapter rather than a generation outcome.
export const SKILL_CATALOG_LOAD_SINK: FailureSink = failureSink({
  event: "ai_field.skill_catalog_load_failed",
  expected: [],
});
