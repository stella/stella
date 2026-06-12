import { Result } from "better-result";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  hasTanStackInstanceProvider,
  isDeferredServiceTierAvailableForRole,
} from "@/api/lib/tanstack-ai-models";

const config = {
  // Any org member needs to know whether AI is usable; the answer
  // is just two booleans, so it does not require admin scope.
  permissions: { workspace: ["read"] },
} satisfies HandlerConfig;

const readAIAvailability = createSafeRootHandler(
  config,
  // eslint-disable-next-line require-yield -- pure read with no Result.await calls
  async function* ({ orgAIConfig }) {
    const instanceProvisioned = hasTanStackInstanceProvider();
    const orgConfigured = orgAIConfig !== null;
    return Result.ok({
      instanceProvisioned,
      orgConfigured,
      available: instanceProvisioned || orgConfigured,
      deferredServiceTierAvailable: isDeferredServiceTierAvailableForRole(
        "pdf",
        orgAIConfig,
      ),
    });
  },
);

export default readAIAvailability;
