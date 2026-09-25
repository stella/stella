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

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { extractSkillRefSlugs } from "@/api/lib/agent-skills/skill-refs";
import { createSkillTools } from "@/api/lib/agent-skills/skill-tools";
import { listAvailableChatSkillMetadata } from "@/api/lib/agent-skills/skills";
import type { SafeId } from "@/api/lib/branded-types";
import type { ChatToolMap } from "@/api/lib/chat/chat-tool-types";

/** Server-validated identity the skill tools resolve skills against. */
export type SkillToolsContext = {
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  userId: SafeId<"user">;
};

/**
 * Returns the `load-skill` + `read-skill-resource` tool set when `prompt`
 * references at least one skill, otherwise `undefined` so the caller keeps its
 * existing no-tools behaviour. The catalog is the one chat serves: the
 * caller's enabled team and private skills, private first on a slug
 * collision. `ctx` is omitted at boundaries that cannot wire the skill
 * identity; in that case skill refs stay inert (no tools).
 */
export const maybeSkillTools = async (
  prompt: string,
  ctx: SkillToolsContext | undefined,
): Promise<Result<ChatToolMap | undefined, SafeDbError>> => {
  if (ctx === undefined || extractSkillRefSlugs(prompt).length === 0) {
    return Result.ok(undefined);
  }
  const skills = await listAvailableChatSkillMetadata(ctx);
  if (Result.isError(skills)) {
    return Result.err(skills.error);
  }
  if (skills.value.length === 0) {
    return Result.ok(undefined);
  }
  return Result.ok(
    createSkillTools({
      organizationId: ctx.organizationId,
      safeDb: ctx.safeDb,
      skills: skills.value,
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
  "[label](#stella-skill-ref=slug), call load-skill with that slug first, " +
  "then apply the skill's methodology to draft this field. Do not narrate " +
  "loading the skill; return only the field value.";
