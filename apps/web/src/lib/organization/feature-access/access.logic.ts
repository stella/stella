import { Result, TaggedError } from "better-result";

import type { CallerFeature } from "./surfaces";

export class CallerFeatureHiddenError extends TaggedError(
  "CallerFeatureHiddenError",
)<{ message: string; featureId: string }> {}

type CallerCapabilities = Readonly<
  Record<string, { status: "enabled" | "hidden" }>
>;

export const callerFeatureEnabled = (
  capabilities: CallerCapabilities | undefined,
  feature: CallerFeature,
): boolean =>
  capabilities?.[feature.id]?.status === "enabled" &&
  feature.requires.every((id) => capabilities[id]?.status === "enabled");

type RunForCallerFeatureOptions = {
  capabilities: CallerCapabilities;
  feature: CallerFeature;
  load: () => Promise<void>;
};

/** The authorization branch precedes every feature-specific prefetch. */
export const runForCallerFeature = async ({
  capabilities,
  feature,
  load,
}: RunForCallerFeatureOptions) => {
  if (!callerFeatureEnabled(capabilities, feature)) {
    return Result.err(
      new CallerFeatureHiddenError({
        message: "The caller feature is hidden",
        featureId: feature.id,
      }),
    );
  }
  await load();
  return Result.ok(undefined);
};
