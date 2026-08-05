import { captureError } from "@/api/lib/analytics/capture";
import type { ChatTool, ChatToolMap } from "@/api/lib/chat/chat-tool-types";
import { TelemetryError } from "@/api/lib/errors/tagged-errors";

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

/**
 * Policy kinds that gate a tool call on user approval, derived from
 * `CHAT_TOOL_POLICIES["needsApproval"]` rather than hand-listed — a kind
 * whose `needsApproval` flips silently carries every tool mapped to it
 * along with it.
 */
export type NeedsApprovalPolicyKind = {
  [K in ChatToolPolicyKind]: (typeof CHAT_TOOL_POLICIES)[K]["needsApproval"] extends true
    ? K
    : never;
}[ChatToolPolicyKind];

const chatToolPolicies = new WeakMap<ChatTool, ChatToolPolicy>();

// Tool names already reported for a policy-map miss this process, so a hot
// loop (e.g. a tool re-checked on every turn) can't spam telemetry.
const reportedPolicyMissToolNames = new Set<string>();

/**
 * A miss means `toolDefinition` reached this call without ever passing
 * through `applyChatToolPolicy` (or `copyChatToolPolicy` from a tool that
 * did). Falling back to `internal` is a deliberate fail-open: org-configured
 * external MCP tools must never brick chat over a policy-registration bug.
 * Tighten this to fail-closed once telemetry confirms misses don't happen.
 */
export const getChatToolPolicy = (toolDefinition: ChatTool): ChatToolPolicy => {
  const policy = chatToolPolicies.get(toolDefinition);
  if (policy) {
    return policy;
  }

  if (!reportedPolicyMissToolNames.has(toolDefinition.name)) {
    reportedPolicyMissToolNames.add(toolDefinition.name);
    captureError(
      new TelemetryError({
        message:
          "Chat tool policy lookup missed; falling back to internal policy",
      }),
      { source: "chat-tool-policy", toolName: toolDefinition.name },
    );
  }

  return CHAT_TOOL_POLICIES.internal;
};

/**
 * Copy `from`'s recorded policy onto `to`. The policy WeakMap is keyed by tool
 * object identity, so a cloned tool (e.g. the subagent projection spreads a
 * tool to strip its approval gate) is unknown to it and `getChatToolPolicy`
 * would fall back to `internal`. That is unsafe under anonymization: a public
 * tool wrongly treated as internal has its inputs de-anonymized before execute,
 * leaking real values to an external provider. Preserve the original policy.
 */
export const copyChatToolPolicy = (from: ChatTool, to: ChatTool): void => {
  chatToolPolicies.set(to, getChatToolPolicy(from));
};

export const applyChatToolPolicy = <TTool extends ChatTool>(
  toolDefinition: TTool,
  policyKind: ChatToolPolicyKind,
): TTool => {
  const policy = CHAT_TOOL_POLICIES[policyKind];
  chatToolPolicies.set(toolDefinition, policy);

  return Object.assign(toolDefinition, {
    ...(policy.needsApproval ? { needsApproval: true } : {}),
  });
};

type ApplyChatToolPoliciesOptions<TTools extends ChatToolMap> = {
  defaultPolicyKind?: ChatToolPolicyKind | undefined;
  policyKinds?: Partial<Record<keyof TTools & string, ChatToolPolicyKind>>;
  tools: TTools;
};

export const applyChatToolPolicies = <TTools extends ChatToolMap>({
  defaultPolicyKind,
  policyKinds = {},
  tools,
}: ApplyChatToolPoliciesOptions<TTools>): TTools => {
  for (const [name, toolDefinition] of Object.entries(tools)) {
    if (!toolDefinition) {
      continue;
    }

    const policyKind = policyKinds[name] ?? defaultPolicyKind;
    if (!policyKind) {
      continue;
    }

    applyChatToolPolicy(toolDefinition, policyKind);
  }

  return tools;
};
