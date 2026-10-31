import { panic, type Result } from "better-result";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import type { ChatMessage, ChatPart } from "@/api/handlers/chat/types";
import {
  skillBindingAllows,
  type SkillBindingScope,
} from "@/api/lib/agent-skills/binding";
import {
  SKILL_CONTENT_TOOL_NAME,
  type SkillContentToolName,
} from "@/api/lib/agent-skills/skill-content-tools";
import {
  loadReadableChatSkillBindings,
  type ReadableChatSkillBinding,
} from "@/api/lib/agent-skills/skills";
import type { SafeId } from "@/api/lib/branded-types";
import { parsePersistedAgentSkillId } from "@/api/lib/safe-id-boundaries";

export const SKILL_HISTORY_UNAVAILABLE = {
  reason: "binding-scope",
  status: "skill-unavailable",
} as const;
const SKILL_HISTORY_UNAVAILABLE_TEXT =
  "Skill unavailable in this conversation scope.";

type SkillUnavailableOutput = typeof SKILL_HISTORY_UNAVAILABLE & {
  skillName: string;
};

type HistoricalSkillContent = {
  contentHash: string;
  skillId: SafeId<"agentSkill">;
  skillName: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const historicalInstalledSkill = (
  part: Extract<ChatPart, { type: "tool-call" }>,
): HistoricalSkillContent | null => {
  if (
    part.state !== "complete" ||
    !isRecord(part.output) ||
    typeof part.output["skillId"] !== "string" ||
    typeof part.output["contentHash"] !== "string"
  ) {
    return null;
  }
  const skillId = parsePersistedAgentSkillId(part.output["skillId"]);
  if (skillId === null) {
    return null;
  }
  const skillName =
    part.name === SKILL_CONTENT_TOOL_NAME.load
      ? part.output["name"]
      : part.output["skillName"];
  return typeof skillName === "string"
    ? {
        contentHash: part.output["contentHash"],
        skillId,
        skillName,
      }
    : null;
};

const historicalSkillName = (
  part: Extract<ChatPart, { type: "tool-call" }>,
): string | null => {
  if (part.state !== "complete" || !isRecord(part.output)) {
    return null;
  }
  const name =
    part.name === SKILL_CONTENT_TOOL_NAME.load
      ? part.output["name"]
      : part.output["skillName"];
  return typeof name === "string" ? name : null;
};

const unavailableOutput = (skillName: string): SkillUnavailableOutput => ({
  ...SKILL_HISTORY_UNAVAILABLE,
  skillName,
});

export const SKILL_HISTORY_PROJECTION_BY_TOOL = {
  [SKILL_CONTENT_TOOL_NAME.load]: "withhold-load",
  [SKILL_CONTENT_TOOL_NAME.readResource]: "withhold-resource",
} as const satisfies Record<SkillContentToolName, string>;

type SkillContentCall = Extract<
  ChatPart,
  { name: SkillContentToolName; type: "tool-call" }
>;

const isSkillContentCall = (part: ChatPart): part is SkillContentCall =>
  part.type === "tool-call" &&
  Object.hasOwn(SKILL_HISTORY_PROJECTION_BY_TOOL, part.name);

const projectUnavailable = (
  part: SkillContentCall,
  skillName: string,
): SkillContentCall => {
  switch (part.name) {
    case SKILL_CONTENT_TOOL_NAME.load:
      return {
        ...part,
        output: {
          contentHash: null,
          description: SKILL_HISTORY_UNAVAILABLE_TEXT,
          instructions: SKILL_HISTORY_UNAVAILABLE_TEXT,
          name: skillName,
          resources: [],
          skillId: null,
          version: null,
        },
      };
    case SKILL_CONTENT_TOOL_NAME.readResource:
      return {
        ...part,
        output: {
          content: SKILL_HISTORY_UNAVAILABLE_TEXT,
          contentHash: null,
          mimeType: "text/plain",
          path: "unavailable",
          skillId: null,
          skillName,
        },
      };
    default: {
      part satisfies never;
      return panic("unknown skill-content history tool");
    }
  }
};

const isAllowed = (
  historical: HistoricalSkillContent | null,
  bindings: ReadonlyMap<string, ReadableChatSkillBinding>,
  scope: SkillBindingScope,
): boolean => {
  if (historical === null) {
    return false;
  }
  const binding = bindings.get(historical.skillId);
  return (
    binding !== undefined &&
    binding.contentHash === historical.contentHash &&
    skillBindingAllows(scope, binding)
  );
};

/** Model-only projection: stored messages retain original skill-owned content. */
export const projectLoadedSkillHistory = ({
  bindings,
  messages,
  scope,
}: {
  bindings: ReadonlyMap<string, ReadableChatSkillBinding>;
  messages: readonly ChatMessage[];
  scope: SkillBindingScope;
}): ChatMessage[] => {
  const withheldByCallId = new Map<string, SkillUnavailableOutput>();
  const callsProjected = messages.map((message) => ({
    ...message,
    parts: message.parts.map((part): ChatPart => {
      if (!isSkillContentCall(part)) {
        return part;
      }
      const skillName = historicalSkillName(part);
      if (skillName === null) {
        return part;
      }
      const historical = historicalInstalledSkill(part);
      // A null skill id identifies shipped, unbound content. Missing identity
      // fields on older installed reads are deliberately unresolvable.
      if (isRecord(part.output) && part.output["skillId"] === null) {
        return part;
      }
      if (isAllowed(historical, bindings, scope)) {
        return part;
      }
      const output = unavailableOutput(skillName);
      withheldByCallId.set(part.id, output);
      return projectUnavailable(part, skillName);
    }),
  }));

  return callsProjected.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (part.type !== "tool-result") {
        return part;
      }
      const output = withheldByCallId.get(part.toolCallId);
      return output === undefined
        ? part
        : { ...part, content: JSON.stringify(output) };
    }),
  }));
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
  const skillIds = new Set<SafeId<"agentSkill">>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (!isSkillContentCall(part)) {
        continue;
      }
      const historical = historicalInstalledSkill(part);
      if (historical !== null) {
        skillIds.add(historical.skillId);
      }
    }
  }
  const bindings = await loadReadableChatSkillBindings({
    organizationId,
    safeDb,
    skillIds: [...skillIds],
    userId,
  });
  return bindings.map((resolved) =>
    projectLoadedSkillHistory({ bindings: resolved, messages, scope }),
  );
};
