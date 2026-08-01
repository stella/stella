import { Result } from "better-result";

import { TOGGLEABLE_NATIVE_TOOL_BACKEND_SLUGS } from "@stll/catalogue";

import { createSafeSessionHandler } from "@/api/lib/api-handlers";
import type { SessionHandlerConfig } from "@/api/lib/api-handlers";
import { isBusinessRegistryNativeToolDeployAvailable } from "@/api/lib/business-registries/dispatch";

const config = {
  mcp: { type: "internal", reason: "deploy_mechanics" },
} satisfies SessionHandlerConfig;

const nativeToolDeployAvailability = createSafeSessionHandler(config, () => {
  return Result.ok({
    unavailableNativeToolBackendSlugs:
      TOGGLEABLE_NATIVE_TOOL_BACKEND_SLUGS.filter(
        (backendSlug) =>
          !isBusinessRegistryNativeToolDeployAvailable(backendSlug),
      ),
  });
});

export default nativeToolDeployAvailability;
