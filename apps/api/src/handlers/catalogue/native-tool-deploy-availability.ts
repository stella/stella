import { Result } from "better-result";

import { TOGGLEABLE_NATIVE_TOOL_BACKEND_SLUGS } from "@stll/catalogue";

import { createSafeSessionHandler } from "@/api/lib/api-handlers";
import type { SessionHandlerConfig } from "@/api/lib/api-handlers";
import { isBusinessRegistryNativeToolDeployAvailable } from "@/api/lib/business-registries/dispatch";

const config = {} satisfies SessionHandlerConfig;

const nativeToolDeployAvailability = createSafeSessionHandler(
  config,
  // eslint-disable-next-line require-yield -- createSafeSessionHandler expects a Result generator.
  async function* () {
    return Result.ok({
      unavailableNativeToolBackendSlugs:
        TOGGLEABLE_NATIVE_TOOL_BACKEND_SLUGS.filter(
          (backendSlug) =>
            !isBusinessRegistryNativeToolDeployAvailable(backendSlug),
        ),
    });
  },
);

export default nativeToolDeployAvailability;
