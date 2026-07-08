import { Result } from "better-result";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  getConfiguredChatModelOptions,
  getDefaultChatModelValue,
} from "@/api/lib/chat-model-selection";

const config = {
  // Any org member picking a chat model needs to see the catalog; the
  // response carries only model identifiers, never key material, so this
  // does not require admin scope (mirrors read-ai-availability.ts).
  permissions: { chat: ["create"] },
  mcp: { type: "internal", reason: "assistant_chat" },
} satisfies HandlerConfig;

const getModelOptions = createSafeRootHandler(
  config,
  // eslint-disable-next-line require-yield -- pure read with no Result.await calls
  async function* ({ orgAIConfig, session }) {
    return Result.ok({
      options: getConfiguredChatModelOptions(orgAIConfig),
      defaultValue: getDefaultChatModelValue({
        orgAIConfig,
        organizationId: session.activeOrganizationId,
      }),
    });
  },
);

export default getModelOptions;
