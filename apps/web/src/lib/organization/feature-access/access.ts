import type { ReactElement } from "react";

import { useQuery } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { panic } from "better-result";

import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { queryView } from "@/lib/query-view.logic";
import {
  optionalOrganizationSettingsOptions,
  organizationSettingsOptions,
} from "@/queries/organization-settings";

import { callerFeatureEnabled, runForCallerFeature } from "./access.logic";
import type { CallerFeature } from "./surfaces";

type UseCallerFeatureEnabledOptions = {
  /** Skip the settings request when no caller decision is needed yet. */
  enabled?: boolean;
};

export const useCallerFeatureEnabled = (
  feature: CallerFeature,
  { enabled = true }: UseCallerFeatureEnabledOptions = {},
): boolean => {
  const user = useMaybeAuthenticatedUser();
  const query = useQuery({
    ...optionalOrganizationSettingsOptions({
      organizationId: user?.activeOrganizationId ?? null,
      userId: user?.id ?? "",
    }),
    enabled,
    retry: false,
    staleTime: 30_000,
  });
  const view = queryView(query);
  switch (view.type) {
    case "pending":
    case "error":
    case "empty":
      return false;
    case "items":
      return (
        view.refetchError === undefined &&
        callerFeatureEnabled(view.items, feature)
      );
    default:
      view satisfies never;
      return panic("Unknown caller feature query state");
  }
};

type LoadCallerFeatureOptions = {
  queryClient: QueryClient;
  principal: { organizationId: string; userId: string };
  feature: CallerFeature;
  load: () => Promise<void>;
};

export const loadCallerFeature = async ({
  queryClient,
  principal,
  feature,
  load,
}: LoadCallerFeatureOptions) => {
  // Route admission refreshes the server decision, including after revocation.
  const settings = await queryClient.query({
    ...organizationSettingsOptions(principal),
    retry: false,
    staleTime: 0,
  });
  return await runForCallerFeature({
    availability: settings,
    feature,
    load,
  });
};

const FEATURE_ADMISSION = Symbol("FeatureAdmission");

/** All caller-gated send, link, and future AI-draft controls reuse this proof; only this owner mints it. */
export type FeatureAdmission<Id extends CallerFeature["id"]> = {
  readonly [FEATURE_ADMISSION]: Id;
};

type CallerFeatureGateProps<Feature extends CallerFeature> = {
  feature: Feature;
  children: (admission: FeatureAdmission<Feature["id"]>) => ReactElement;
};

/** Admission refreshes with the caller decision; controls must not retain it in state. */
export const useCallerFeatureAdmission = <Feature extends CallerFeature>(
  feature: Feature,
): FeatureAdmission<Feature["id"]> | undefined => {
  const enabled = useCallerFeatureEnabled(feature);
  return enabled ? { [FEATURE_ADMISSION]: feature.id } : undefined;
};

export const CallerFeatureGate = <Feature extends CallerFeature>({
  feature,
  children,
}: CallerFeatureGateProps<Feature>): ReactElement | null => {
  const admission = useCallerFeatureAdmission(feature);
  return admission === undefined ? null : children(admission);
};
