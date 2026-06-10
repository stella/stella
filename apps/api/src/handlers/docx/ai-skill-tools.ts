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

import type { ToolSet } from "ai";

import type { SafeDb } from "@/api/db";
import { getChatSkillMetadata } from "@/api/handlers/chat/skills";
import { createSkillTools } from "@/api/handlers/chat/tools/skill-tools";
import type { SafeId } from "@/api/lib/branded-types";

/**
 * Mirrors `SKILL_CHIP_HREF_PREFIX` on the web side (the prompt inputs serialize
 * skill chips as `[label](#stella-skill-ref=slug)`). The slug sits inside the
 * markdown link target, so it runs up to the closing paren or whitespace.
 */
const SKILL_REF_RE = /#stella-skill-ref=([^)\s]+)/u;

/** Server-validated identity the skill tools resolve skills against. */
export type SkillToolsContext = {
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  userId: SafeId<"user">;
};

/**
 * Returns the `load-skill` + `read-skill-resource` tool set when `prompt`
 * references at least one skill, otherwise `undefined` so the caller keeps its
 * existing no-tools behaviour. `ctx` is omitted at boundaries that cannot wire
 * the skill identity yet; in that case skill refs stay inert (no tools).
 */
export const maybeSkillTools = (
  prompt: string,
  ctx: SkillToolsContext | undefined,
): ToolSet | undefined => {
  if (ctx === undefined || !SKILL_REF_RE.test(prompt)) {
    return undefined;
  }
  return createSkillTools({
    organizationId: ctx.organizationId,
    safeDb: ctx.safeDb,
    skills: getChatSkillMetadata(),
    userId: ctx.userId,
  });
};

/**
 * One-shot guidance equivalent to chat's POST-LOAD-SKILL rule: load the
 * referenced skill, apply its methodology to the field, and return only the
 * field value — never a "loaded the skill" confirmation.
 */
export const SKILL_REF_GENERATOR_GUIDANCE =
  "If the instruction contains a markdown link of the form " +
  "[label](#stella-skill-ref=slug), call load-skill with that slug first, " +
  "then apply the skill's methodology to draft this field. Do not narrate " +
  "loading the skill; return only the field value.";
