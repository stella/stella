import { panic } from "better-result";
import type { Result } from "better-result";

import type { SafeDbError } from "@/api/db/safe-db";
import type { ExcludableChatToolName } from "@/api/handlers/chat/tools/excluded-chat-tools";
import { toExcludedChatTools } from "@/api/handlers/chat/tools/excluded-chat-tools";
import type { RejectedChatRead } from "@/api/handlers/chat/tools/execute/documented-chat-reads";
import { toDocumentedChatReads } from "@/api/handlers/chat/tools/execute/documented-chat-reads";
import type { RegistryReadToolName } from "@/api/handlers/chat/tools/registry-adapter/ref-field-map";
import { resolveActiveSkillContext } from "@/api/lib/agent-skills/skills";
import type { ActiveSkillContext } from "@/api/lib/agent-skills/skills";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import { logger } from "@/api/lib/observability/logger";

/**
 * The active skill as the chat surface acts on it: the skill's frontmatter
 * declarations, narrowed once per send to the names chat can honour. The
 * skills module is shared lib code and cannot decide what chat documents or
 * excludes (a decision of the ref-field map and the tool registry), so it
 * resolves the declared strings and this module narrows them where the chat
 * turn is built. Every reader downstream (prompt, streaming tool set, the
 * delegation predicate) takes the narrowed lists as given.
 */
export type ActiveChatSkillContext = Omit<
  ActiveSkillContext,
  "documentedChatReads" | "excludedChatTools"
> & {
  /**
   * Registry reads the skill documents up front on the chat surface
   * (`stella-chat-documented-reads`): code-mode registers them non-lazy and
   * the prompt carries their full stubs while the skill is active. The
   * validation tool set ignores them, as it ignores the exclusion: laziness
   * does not change a tool's schema, so persisted calls parse the same.
   */
  documentedChatReads: readonly RegistryReadToolName[];
  /**
   * Chat tools the skill withholds from a turn it is active in
   * (`stella-chat-excluded-tools`). Read by the registration predicates in
   * chat-tools.ts; the validation tool set ignores it so persisted calls from
   * before the skill was activated still parse.
   */
  excludedChatTools: readonly ExcludableChatToolName[];
};

/**
 * A rejected declaration means a different thing per skill source. A built-in
 * skill is shipped code, so its rejected name panics; the guard tests in
 * `skill-documented-reads.test.ts` and `skill-excluded-tools.test.ts` fail it
 * first. An org-authored `SKILL.md` must not break the turn, so an installed
 * skill's rejected names are dropped with one log per list.
 */
const rejectDeclaration = ({
  described,
  event,
  field,
  skill,
  what,
}: {
  described: string;
  event: `chat.skill.${string}_rejected`;
  field: `skill.rejected_${string}`;
  skill: ActiveSkillContext;
  what: string;
}): void => {
  if (skill.source === "built-in") {
    return panic(
      `Built-in skill ${skill.toolName} ${what} it cannot: ${described}`,
    );
  }
  logger.warn(event, {
    ...(skill.id === null ? {} : { "skill.id": skill.id }),
    [field]: described,
  });
};

const describeRejectedRead = ({ name, reason }: RejectedChatRead): string =>
  `${name} (${reason})`;

/** Narrows a resolved skill's declarations to what chat can act on. */
export const narrowActiveChatSkillContext = (
  skill: ActiveSkillContext,
): ActiveChatSkillContext => {
  const reads = toDocumentedChatReads(skill.documentedChatReads);
  if (reads.rejected.length > 0) {
    rejectDeclaration({
      described: reads.rejected.map(describeRejectedRead).join(", "),
      event: "chat.skill.documented_reads_rejected",
      field: "skill.rejected_reads",
      skill,
      what: "documents chat reads",
    });
  }
  const excluded = toExcludedChatTools(skill.excludedChatTools);
  if (excluded.rejected.length > 0) {
    rejectDeclaration({
      described: excluded.rejected.join(", "),
      event: "chat.skill.excluded_tools_rejected",
      field: "skill.rejected_tools",
      skill,
      what: "excludes chat tools",
    });
  }
  return {
    ...skill,
    documentedChatReads: reads.reads,
    excludedChatTools: excluded.excluded,
  };
};

/**
 * The turn's active skill, resolved and narrowed once per send. Callers pass
 * the result on rather than resolving again, so an installed skill's rejected
 * declaration is logged once and the skill row is read once.
 */
export const resolveActiveChatSkillContext = async (
  request: Parameters<typeof resolveActiveSkillContext>[0],
): Promise<
  Result<ActiveChatSkillContext | null, HandlerError<403 | 404> | SafeDbError>
> =>
  (await resolveActiveSkillContext(request)).map((skill) =>
    skill === null ? null : narrowActiveChatSkillContext(skill),
  );
