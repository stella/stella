import { Result } from "better-result";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  hasTanStackInstanceProvider,
  isDeferredServiceTierAvailableForRole,
} from "@/api/lib/tanstack-ai-models";

const config = {
  description:
    "Report whether AI is usable in this organization: whether the " +
    "deployment provides a model, whether the organization has configured " +
    "its own provider, whether either of those makes AI available at all, " +
    "and whether the reduced-cost deferred service tier can be used. " +
    "Booleans only, so any member may read it.",
  // Any org member needs to know whether AI is usable; the answer
  // is just two booleans, so it does not require admin scope.
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "anonymization_admin" },
  access: "read",
} satisfies HandlerConfig;

const readAIAvailability = createSafeRootHandler(
  config,
  // eslint-disable-next-line require-yield, typescript/require-await -- safe handlers must remain async generators for Result.gen error capture.
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
