import { panic } from "better-result";

import { READ_TOOL_REF_FIELD_MAP } from "@/api/handlers/chat/tools/registry-adapter/ref-field-map";
import type { RegistryReadToolName } from "@/api/handlers/chat/tools/registry-adapter/ref-field-map";
import type { ActiveChatSkillContext } from "@/api/lib/agent-skills/skills";
import { logger } from "@/api/lib/observability/logger";

/**
 * Which reads a skill may document up front on the chat surface, and the one
 * place a frontmatter string becomes a read tool name. The skills module is
 * shared lib code and cannot decide projectability (a chat decision in the
 * ref-field map), so `ActiveChatSkillContext` carries the declared names and
 * `documentedChatReadsOf` narrows them where the chat turn is built. A leaf
 * over the ref-field map, kept out of the code-mode surface so the skills
 * tests and the prompt builders do not pull in the sandbox to narrow a name.
 */

/**
 * The only read tool documented eagerly (full type stub) in the base system
 * prompt; every other chat-projectable read is held out of the eager catalog
 * and reached through `discover_tools`, unless the active skill documents it
 * (`stella-chat-documented-reads`, `chatCodeModeSystemPrompt`).
 *
 * Rationale: code-mode's eager catalog emits a full `interface` + JSDoc +
 * `declare function` per tool, so documenting all reads eagerly ballooned the
 * injected section to ~5.6x the hand-written `READONLY_API_HINT` it replaces.
 * Jan's hard rule is that system prompts stay brief. `list_matters` is the
 * entry-point read (the model almost always lists matters first to get the refs
 * later tools need), so it keeps its eager stub; every other read is advertised
 * by name + first sentence in the Discoverable APIs catalog and its exact schema
 * is fetched on demand via `discover_tools` — the same describe-on-demand
 * ergonomics the old `describe-stella-api` tool gave. This holds the eager
 * section in the same size class as `READONLY_API_HINT` while keeping the full
 * read surface reachable. The brevity rule holds for the base prompt; a skill
 * pays for the reads it documents only on its own turns, under
 * `MAX_DOCUMENTED_CHAT_READS` and the ceiling in
 * `skill-documented-reads.test.ts`.
 */
export const EAGER_CHAT_READ_TOOLS = new Set<RegistryReadToolName>([
  "list_matters",
]);

/** The map is total over the read-tool union (`satisfies Record<...>`), so its keys are exactly the read tool names. */
const isRegistryReadToolName = (name: string): name is RegistryReadToolName =>
  Object.hasOwn(READ_TOOL_REF_FIELD_MAP, name);

/**
 * The reads a skill may document up front: every chat-projectable read that
 * the base prompt does not already document. Derived, so a read that becomes
 * projectable is documentable the same day and an always-eager read never is.
 * Map order; the prompt orders stubs by the registry and the variant key sorts.
 */
export const DOCUMENTABLE_CHAT_READ_NAMES: readonly RegistryReadToolName[] =
  Object.keys(READ_TOOL_REF_FIELD_MAP)
    .filter(isRegistryReadToolName)
    .filter(
      (name) =>
        READ_TOOL_REF_FIELD_MAP[name].chatProjectable &&
        !EAGER_CHAT_READ_TOOLS.has(name),
    );

/**
 * How many reads one skill may document. Keeps a skill's turns in the same
 * size class as the base prompt, and keeps at least one read lazy, which is
 * what lets `buildChatCodeModeTools` rely on the discovery companion. Bump it
 * deliberately, with the skill that needs more; the guard test holds it
 * below the documentable count.
 */
export const MAX_DOCUMENTED_CHAT_READS = 8;

export type RejectedChatRead = {
  name: string;
  reason: "not-documentable" | "over-limit";
};

export type DocumentedChatReads = {
  reads: readonly RegistryReadToolName[];
  rejected: readonly RejectedChatRead[];
};

/**
 * A name outside `DOCUMENTABLE_CHAT_READ_NAMES` (unknown, not projectable, or
 * documented already) and every name past the limit come back in `rejected`;
 * `documentedChatReadsOf` decides what a rejection means per skill source.
 */
export const toDocumentedChatReads = (
  names: readonly string[],
): DocumentedChatReads => {
  const reads: RegistryReadToolName[] = [];
  const rejected: RejectedChatRead[] = [];
  for (const name of names) {
    const read = DOCUMENTABLE_CHAT_READ_NAMES.find(
      (candidate) => candidate === name,
    );
    if (read === undefined) {
      rejected.push({ name, reason: "not-documentable" });
    } else if (reads.length >= MAX_DOCUMENTED_CHAT_READS) {
      rejected.push({ name, reason: "over-limit" });
    } else {
      reads.push(read);
    }
  }
  return { reads, rejected };
};

/**
 * The reads the active skill documents on this turn, narrowed from its
 * declaration. No skill documents nothing. A built-in skill's rejected name
 * panics, since a shipped skill is code and the guard test in
 * `skill-documented-reads.test.ts` fails it first; an installed skill's
 * rejected names are dropped with a log, since an org-authored `SKILL.md`
 * must not break the turn.
 */
export const documentedChatReadsOf = (
  skill: ActiveChatSkillContext | null | undefined,
): readonly RegistryReadToolName[] => {
  if (!skill) {
    return [];
  }
  const { reads, rejected } = toDocumentedChatReads(skill.documentedChatReads);
  if (rejected.length === 0) {
    return reads;
  }
  const described = rejected
    .map(({ name, reason }) => `${name} (${reason})`)
    .join(", ");
  if (skill.source === "built-in") {
    return panic(
      `Built-in skill ${skill.toolName} documents chat reads it cannot: ${described}`,
    );
  }
  logger.warn("chat.skill.documented_reads_rejected", {
    ...(skill.id === null ? {} : { "skill.id": skill.id }),
    "skill.rejected_reads": described,
  });
  return reads;
};
