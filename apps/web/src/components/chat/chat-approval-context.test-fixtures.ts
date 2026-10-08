import type { ComponentProps } from "react";

import type { ChatApprovalContext } from "@/components/chat/chat-approval-context";

/**
 * The approval context every chat-thread render test provides: no grants,
 * inert handlers, and a private-input target that is not saved. One value,
 * so a field the context gains is added here once rather than in each test.
 */
const ignore = () => undefined;

export const testChatApprovalContextValue = {
  activeOrganizationId: "test-active-organization",
  alwaysApprovedTools: new Set(),
  conversationApprovedTools: new Set(),
  handleAllowInConversation: ignore,
  handleAlwaysAllow: ignore,
  handleApprove: ignore,
  handleDeny: ignore,
  continueRequestSecret: async () => await Promise.resolve(),
  handleRequestSecret: async () => ({
    status: "declined",
    target: { type: "mcp-connector", connectorSlug: "test" },
  }),
  secretAvailabilityKey: "test-thread",
  resolveSecretTarget: async () => ({
    available: false,
    connector: {
      connectionId: "sample-connection",
      displayName: "Sample connector",
      host: "sample.test",
      responseDisposition: "normal",
    },
  }),
} satisfies ComponentProps<typeof ChatApprovalContext>["value"];
