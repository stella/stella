import { expect, test } from "bun:test";

import { chatScriptReadToolNames } from "@/api/handlers/chat/tools/execute/chat-code-mode";
import { WRITE_TOOL_REF_FIELD_MAP } from "@/api/handlers/chat/tools/registry-adapter/ref-field-map";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/auth/feature-access/policy";
import { toSafeId } from "@/api/lib/branded-types";
import {
  FEATURE_REGISTRY,
  LIST_VERIFICATION_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import { getStaticMcpToolDefinition } from "@/api/mcp/static-tool-definitions";

// A granted caller exercises the offered tool set, rather than passing because
// feature admission has hidden a future verification reader.
test("chat offers no verification point reader or generic capability invocation", () => {
  const principal = {
    organizationId: toSafeId<"organization">("org_reader"),
    userId: toSafeId<"user">("user_reader"),
  };
  const decision = decideFeatureAccess({
    ...principal,
    registry: FEATURE_REGISTRY,
    featureId: LIST_VERIFICATION_FEATURE_ID,
    grants: {
      [LIST_VERIFICATION_FEATURE_ID]: [
        { type: "organization", organizationId: principal.organizationId },
      ],
    },
    user: { email: "reader@example.test", emailVerified: true },
    membership: true,
  });
  expect(decision.status).toBe("enabled");
  const featureAccessSnapshot = createFeatureAccessSnapshot({
    ...principal,
    decisions: new Map([[LIST_VERIFICATION_FEATURE_ID, decision]]),
  });
  const tools = chatScriptReadToolNames({
    ...principal,
    featureAccessSnapshot,
  });
  expect(tools.length).toBeGreaterThan(0);
  expect(WRITE_TOOL_REF_FIELD_MAP.write_capability.chatProjectable).toBe(false);
  expect(tools).not.toContain("write_capability");
  for (const name of tools) {
    const definition = getStaticMcpToolDefinition(name);
    expect(definition).toBeDefined();
    expect(definition?.featureId).not.toBe(LIST_VERIFICATION_FEATURE_ID);
    expect(name).not.toMatch(/verification|verifications/u);
  }
});
