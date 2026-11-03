import type { ContextType } from "react";

import type { ChatApprovalContext } from "@/components/chat/chat-approval-context";

type PlaygroundChatApproval = NonNullable<
  ContextType<typeof ChatApprovalContext>
>;

const noop = () => {
  /* no-op in playground */
};

/**
 * One inert approval context for every dev playground, so a new approval
 * capability is stubbed once instead of in each fixture.
 */
export const createPlaygroundChatApproval = (
  activeOrganizationId: string,
): PlaygroundChatApproval => ({
  activeOrganizationId,
  alwaysApprovedTools: new Set(),
  conversationApprovedTools: new Set(),
  confirmStoredApprovalGrant: async () => await Promise.resolve(false),
  handleAllowInConversation: noop,
  handleAlwaysAllow: noop,
  handleApprove: noop,
  handleDeny: noop,
  continueRequestSecret: async () => {
    /* no-op in playground */
  },
  continueConnectConnector: async () => {
    /* no-op in playground */
  },
  handleConnectConnector: async () =>
    await Promise.resolve({ status: "declined", connectorSlug: "playground" }),
  handleRequestSecret: async () =>
    await Promise.resolve({
      status: "declined",
      target: { type: "mcp-connector", connectorSlug: "playground" },
    }),
  secretAvailabilityKey: "playground-thread",
  resolveSecretTarget: async () =>
    await Promise.resolve({
      available: false,
      connector: {
        connectionId: "sample-connection",
        displayName: "Sample connector",
        host: "sample.test",
        responseDisposition: "normal",
      },
    }),
});
