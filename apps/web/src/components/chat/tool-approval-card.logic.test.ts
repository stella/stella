import { describe, expect, test } from "bun:test";

import { USE_CONNECTOR_SECRET_TOOL_NAME } from "@stll/api-contract/chat-secret";

import {
  getToolApprovalGrant,
  type ToolApprovalGrant,
} from "@/components/chat/chat-ui-tools";
import { hasAutomaticApproval } from "@/components/chat/tool-approval-card.logic";

describe("tool approval grant policy", () => {
  test("does not use preseeded grants for private connector operations", () => {
    const grant = getToolApprovalGrant(USE_CONNECTOR_SECRET_TOOL_NAME);
    const grants = new Set<ToolApprovalGrant>([grant]);

    expect(
      hasAutomaticApproval({
        alwaysApprovedTools: grants,
        canAlwaysAllow: true,
        conversationApprovedTools: grants,
        isPublicOfficialApproval: true,
        name: USE_CONNECTOR_SECRET_TOOL_NAME,
      }),
    ).toBe(false);
  });
});
