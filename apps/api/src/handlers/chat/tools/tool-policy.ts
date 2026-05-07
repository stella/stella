import type { ToolSet } from "ai";

export const CHAT_TOOL_POLICY_KIND = {
  external: "external",
  internal: "internal",
  mutation: "mutation",
  publicLookup: "publicLookup",
} as const;

export type ChatToolPolicyKind =
  (typeof CHAT_TOOL_POLICY_KIND)[keyof typeof CHAT_TOOL_POLICY_KIND];

export type ChatToolPolicy = {
  needsApproval: boolean;
  requiresAnonymization: boolean;
};

const CHAT_TOOL_POLICIES = {
  [CHAT_TOOL_POLICY_KIND.external]: {
    needsApproval: true,
    requiresAnonymization: true,
  },
  [CHAT_TOOL_POLICY_KIND.internal]: {
    needsApproval: false,
    requiresAnonymization: false,
  },
  [CHAT_TOOL_POLICY_KIND.mutation]: {
    needsApproval: true,
    requiresAnonymization: false,
  },
  [CHAT_TOOL_POLICY_KIND.publicLookup]: {
    needsApproval: false,
    requiresAnonymization: false,
  },
} as const satisfies Record<ChatToolPolicyKind, ChatToolPolicy>;

const CHAT_TOOL_POLICY_SYMBOL = Symbol.for("stella.chat.toolPolicy");

type ToolDefinition = NonNullable<ToolSet[string]>;
type ToolDefinitionWithPolicy = ToolDefinition & {
  [CHAT_TOOL_POLICY_SYMBOL]?: ChatToolPolicy | undefined;
};

export const getChatToolPolicy = (
  toolDefinition: ToolDefinition,
): ChatToolPolicy =>
  (toolDefinition as ToolDefinitionWithPolicy)[CHAT_TOOL_POLICY_SYMBOL] ??
  CHAT_TOOL_POLICIES.internal;

export const applyChatToolPolicy = <TTool extends ToolDefinition>(
  toolDefinition: TTool,
  policyKind: ChatToolPolicyKind,
): TTool => {
  const policy = CHAT_TOOL_POLICIES[policyKind];

  return Object.assign(toolDefinition, {
    [CHAT_TOOL_POLICY_SYMBOL]: policy,
    ...(policy.needsApproval ? { needsApproval: true } : {}),
  });
};

type ApplyChatToolPoliciesOptions<TTools extends ToolSet> = {
  defaultPolicyKind?: ChatToolPolicyKind | undefined;
  policyKinds?: Partial<Record<keyof TTools & string, ChatToolPolicyKind>>;
  tools: TTools;
};

export const applyChatToolPolicies = <TTools extends ToolSet>({
  defaultPolicyKind,
  policyKinds = {},
  tools,
}: ApplyChatToolPoliciesOptions<TTools>): TTools => {
  for (const [name, toolDefinition] of Object.entries(tools)) {
    const policyKind = policyKinds[name] ?? defaultPolicyKind;
    if (!policyKind) {
      continue;
    }

    applyChatToolPolicy(toolDefinition, policyKind);
  }

  return tools;
};
