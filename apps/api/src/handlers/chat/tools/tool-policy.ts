import {
  CHAT_TOOL_POLICY_KIND,
  CHAT_TOOL_POLICY_REQUIRES_APPROVAL,
  type ChatToolPolicyKind,
  type NeedsApprovalPolicyKind,
} from "@stll/api-contract";

import { captureError } from "@/api/lib/analytics/capture";
import type { ChatTool, ChatToolMap } from "@/api/lib/chat/chat-tool-types";
import { TelemetryError } from "@/api/lib/errors/tagged-errors";

export { CHAT_TOOL_POLICY_KIND };
export type { ChatToolPolicyKind, NeedsApprovalPolicyKind };

export type ChatToolPolicy = {
  kind: ChatToolPolicyKind;
  needsApproval: boolean;
  requiresAnonymization: boolean;
};

const CHAT_TOOL_POLICIES = {
  [CHAT_TOOL_POLICY_KIND.external]: {
    kind: CHAT_TOOL_POLICY_KIND.external,
    needsApproval:
      CHAT_TOOL_POLICY_REQUIRES_APPROVAL[CHAT_TOOL_POLICY_KIND.external],
    requiresAnonymization: false,
  },
  [CHAT_TOOL_POLICY_KIND.internal]: {
    kind: CHAT_TOOL_POLICY_KIND.internal,
    needsApproval:
      CHAT_TOOL_POLICY_REQUIRES_APPROVAL[CHAT_TOOL_POLICY_KIND.internal],
    requiresAnonymization: false,
  },
  [CHAT_TOOL_POLICY_KIND.mutation]: {
    kind: CHAT_TOOL_POLICY_KIND.mutation,
    needsApproval:
      CHAT_TOOL_POLICY_REQUIRES_APPROVAL[CHAT_TOOL_POLICY_KIND.mutation],
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
    needsApproval:
      CHAT_TOOL_POLICY_REQUIRES_APPROVAL[CHAT_TOOL_POLICY_KIND.publicOfficial],
    requiresAnonymization: false,
  },
  /**
   * Unofficial public endpoints are still external services. They may
   * be unauthenticated, so Stella asks before sending data. The
   * anonymization boundary is inherited from the current chat mode.
   */
  [CHAT_TOOL_POLICY_KIND.publicUnofficial]: {
    kind: CHAT_TOOL_POLICY_KIND.publicUnofficial,
    needsApproval:
      CHAT_TOOL_POLICY_REQUIRES_APPROVAL[
        CHAT_TOOL_POLICY_KIND.publicUnofficial
      ],
    requiresAnonymization: false,
  },
} as const satisfies Record<ChatToolPolicyKind, ChatToolPolicy>;

const MISSING_CHAT_TOOL_POLICY = Symbol("missing-chat-tool-policy");
const chatToolPolicies = new WeakMap<
  ChatTool,
  ChatToolPolicy | typeof MISSING_CHAT_TOOL_POLICY
>();

const missingChatToolPolicy = (toolDefinition: ChatTool): never => {
  /**
   * A miss means `toolDefinition` reached this call without ever passing
   * through `applyChatToolPolicy` (or `copyChatToolPolicy` from a tool that
   * did). This is a policy-registration invariant, not a safe default: an
   * internal fallback could de-anonymize input before an external call or
   * bypass approval for a mutation.
   */
  if (chatToolPolicies.get(toolDefinition) !== MISSING_CHAT_TOOL_POLICY) {
    // The WeakMap marker deduplicates repeated failures per tool instance
    // without retaining short-lived tool objects forever.
    chatToolPolicies.set(toolDefinition, MISSING_CHAT_TOOL_POLICY);
    captureError(
      new TelemetryError({
        message: "Chat tool policy lookup missed; refusing to execute tool",
      }),
      { source: "chat-tool-policy", toolName: toolDefinition.name },
    );
  }

  throw new TelemetryError({
    message: `Chat tool policy is missing for "${toolDefinition.name}"`,
  });
};

/** Return the policy registered for a tool, failing closed if it is absent. */
export const getChatToolPolicy = (toolDefinition: ChatTool): ChatToolPolicy => {
  const policy = chatToolPolicies.get(toolDefinition);
  if (policy !== undefined && policy !== MISSING_CHAT_TOOL_POLICY) {
    return policy;
  }

  return missingChatToolPolicy(toolDefinition);
};

/**
 * Copy `from`'s recorded policy onto `to`. The policy WeakMap is keyed by tool
 * object identity, so a cloned tool (e.g. the subagent projection spreads a
 * tool to strip its approval gate) is unknown to it and `getChatToolPolicy`
 * would fail closed. Preserve the original policy so the safe clone remains
 * usable without weakening the registration invariant.
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

type ApplyChatToolPoliciesOptions<TTools extends ChatToolMap> =
  | {
      /** A default makes sparse per-name overrides safe by construction. */
      defaultPolicyKind: ChatToolPolicyKind;
      policyKinds?: Partial<Record<keyof TTools & string, ChatToolPolicyKind>>;
      tools: TTools;
    }
  | {
      /** Without a default, every tool key must carry an explicit policy. */
      defaultPolicyKind?: never;
      policyKinds: Record<keyof TTools & string, ChatToolPolicyKind>;
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
    if (policyKind === undefined) {
      // Dynamic tools can arrive pre-classified before this total built-in
      // pass. Preserve that registration; an unregistered tool still fails
      // closed through the same lookup.
      getChatToolPolicy(toolDefinition);
      continue;
    }

    applyChatToolPolicy(toolDefinition, policyKind);
  }

  return tools;
};
