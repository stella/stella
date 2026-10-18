import { Result } from "better-result";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import type { ChatMessage, ChatPart } from "@/api/handlers/chat/types";
import {
  skillBindingAllows,
  type SkillBinding,
  type SkillBindingScope,
} from "@/api/lib/agent-skills/binding";
import { loadReadableChatSkillBindings } from "@/api/lib/agent-skills/skills";
import type { SafeId } from "@/api/lib/branded-types";

export const SKILL_HISTORY_UNAVAILABLE = {
  reason: "binding-scope",
  status: "skill-unavailable",
} as const;
export const SKILL_HISTORY_UNAVAILABLE_TEXT =
  "Skill unavailable in this conversation scope.";

type SkillUnavailableOutput = typeof SKILL_HISTORY_UNAVAILABLE & {
  skillName: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const loadedSkillName = (part: ChatPart): string | null => {
  if (
    part.type !== "tool-call" ||
    part.name !== "load-skill" ||
    part.state !== "complete" ||
    !isRecord(part.output) ||
    typeof part.output["name"] !== "string" ||
    typeof part.output["instructions"] !== "string"
  ) {
    return null;
  }
  return part.output["name"];
};

const unavailableOutput = (skillName: string): SkillUnavailableOutput => ({
  ...SKILL_HISTORY_UNAVAILABLE,
  skillName,
});

/** Model-only projection: stored messages retain the original skill body. */
export const projectLoadedSkillHistory = ({
  bindings,
  messages,
  scope,
}: {
  bindings: ReadonlyMap<string, SkillBinding>;
  messages: readonly ChatMessage[];
  scope: SkillBindingScope;
}): ChatMessage[] => {
  const projected: ChatMessage[] = [];
  for (const message of messages) {
    const withheldByCallId = new Map<string, SkillUnavailableOutput>();
    const parts: ChatPart[] = message.parts.map((part) => {
      const skillName = loadedSkillName(part);
      if (
        skillName === null ||
        part.type !== "tool-call" ||
        part.name !== "load-skill"
      ) {
        return part;
      }
      const binding = bindings.get(skillName);
      if (binding === undefined || skillBindingAllows(scope, binding)) {
        return part;
      }
      const output = unavailableOutput(skillName);
      withheldByCallId.set(part.id, output);
      return {
        ...part,
        output: {
          description: SKILL_HISTORY_UNAVAILABLE_TEXT,
          instructions: SKILL_HISTORY_UNAVAILABLE_TEXT,
          name: skillName,
          resources: [],
          version: null,
        },
      };
    });

    projected.push({
      ...message,
      parts: parts.map((part) => {
        if (part.type !== "tool-result") {
          return part;
        }
        const output = withheldByCallId.get(part.toolCallId);
        return output === undefined
          ? part
          : { ...part, content: JSON.stringify(output) };
      }),
    });
  }
  return projected;
};

export const enforceLoadedSkillHistoryBindings = async ({
  messages,
  organizationId,
  safeDb,
  scope,
  userId,
}: {
  messages: readonly ChatMessage[];
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  scope: SkillBindingScope;
  userId: SafeId<"user">;
}): Promise<Result<ChatMessage[], SafeDbError>> => {
  const skillNames = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      const name = loadedSkillName(part);
      if (name !== null) {
        skillNames.add(name);
      }
    }
  }
  if (skillNames.size === 0) {
    return Result.ok([...messages]);
  }
  const bindings = await loadReadableChatSkillBindings({
    organizationId,
    safeDb,
    skillNames: [...skillNames],
    userId,
  });
  return bindings.map((resolved) =>
    projectLoadedSkillHistory({ bindings: resolved, messages, scope }),
  );
};
