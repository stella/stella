import { panic, Result, TaggedError } from "better-result";

import type { OrganizationSettings } from "@/queries/organization-settings";

import type { CallerFeature } from "./surfaces";

class CallerFeatureHiddenError extends TaggedError("CallerFeatureHiddenError")<{
  message: string;
  featureId: string;
}> {}

type CallerAvailability = Pick<
  OrganizationSettings,
  "capabilities" | "declaredFeatureIds" | "deploymentFeatures"
>;

const admittedByServer = (
  availability: CallerAvailability,
  feature: CallerFeature,
): boolean => {
  if (availability.declaredFeatureIds.includes(feature.id)) {
    return availability.capabilities[feature.id]?.status === "enabled";
  }
  switch (feature.undeclared.type) {
    case "hidden":
      return false;
    // Delete this undeclared policy when the server declares legal-lists.
    case "deployment-and-enabled-for":
      return (
        availability.deploymentFeatures[feature.undeclared.key] &&
        // Read the server decision directly: dependent features require Lists.
        feature.undeclared.featureIds.some(
          (id) =>
            availability.declaredFeatureIds.includes(id) &&
            availability.capabilities[id]?.status === "enabled",
        )
      );
    default:
      feature.undeclared satisfies never;
      return panic("Unknown undeclared feature policy");
  }
};

export const callerFeatureEnabled = (
  availability: CallerAvailability | undefined,
  feature: CallerFeature,
): boolean =>
  availability !== undefined &&
  admittedByServer(availability, feature) &&
  feature.requires.every((dependency) =>
    admittedByServer(availability, dependency),
  );

type RunForCallerFeatureOptions = {
  availability: CallerAvailability;
  feature: CallerFeature;
  load: () => Promise<void>;
};

/** The authorization branch precedes every feature-specific prefetch. */
export const runForCallerFeature = async ({
  availability,
  feature,
  load,
}: RunForCallerFeatureOptions) => {
  if (!callerFeatureEnabled(availability, feature)) {
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
