import type { ToolSet } from "ai";

export const CHAT_TOOL_POLICY_KIND = {
  external: "external",
  internal: "internal",
  mutation: "mutation",
  publicOfficial: "public_official",
  publicUnofficial: "public_unofficial",
} as const;

export type ChatToolPolicyKind =
  (typeof CHAT_TOOL_POLICY_KIND)[keyof typeof CHAT_TOOL_POLICY_KIND];

export type ChatToolPolicy = {
  kind: ChatToolPolicyKind;
  needsApproval: boolean;
  requiresAnonymization: boolean;
};

const CHAT_TOOL_POLICIES = {
  [CHAT_TOOL_POLICY_KIND.external]: {
    kind: CHAT_TOOL_POLICY_KIND.external,
    needsApproval: true,
    requiresAnonymization: false,
  },
  [CHAT_TOOL_POLICY_KIND.internal]: {
    kind: CHAT_TOOL_POLICY_KIND.internal,
    needsApproval: false,
    requiresAnonymization: false,
  },
  [CHAT_TOOL_POLICY_KIND.mutation]: {
    kind: CHAT_TOOL_POLICY_KIND.mutation,
    needsApproval: true,
    requiresAnonymization: false,
  },
  /**
   * Official public endpoints are authoritative government/public-body
   * registries designed to receive the lookup key the user supplied
   * (for example an ICO or company name sent to ARES). These tools may
   * send that lookup input directly: they must not include workspace
   * document text or other privileged context in their schema.
   */
  [CHAT_TOOL_POLICY_KIND.publicOfficial]: {
    kind: CHAT_TOOL_POLICY_KIND.publicOfficial,
    needsApproval: false,
    requiresAnonymization: false,
  },
  /**
   * Unofficial public endpoints are still external services. They may
   * be unauthenticated, so Stella asks before sending data. The
   * anonymization boundary is inherited from the current chat mode.
   */
  [CHAT_TOOL_POLICY_KIND.publicUnofficial]: {
    kind: CHAT_TOOL_POLICY_KIND.publicUnofficial,
    needsApproval: true,
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
  // SAFETY: widening to read the optional Stella-private policy symbol that
  // applyChatToolPolicy attaches via Object.assign. The symbol property is
  // typed optional and the ?? fallback covers tools that were never tagged.
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
