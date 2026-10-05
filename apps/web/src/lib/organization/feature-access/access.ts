import { useQuery } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { panic } from "better-result";

import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { useQueryView } from "@/lib/use-query-view";
import {
  organizationSettingsOptions,
  optionalOrganizationSettingsOptions,
} from "@/queries/organization-settings";

import { callerFeatureEnabled, runForCallerFeature } from "./access.logic";
import type { CallerFeature } from "./surfaces";

export const useCallerFeatureEnabled = (feature: CallerFeature): boolean => {
  const user = useMaybeAuthenticatedUser();
  const query = useQuery({
    ...optionalOrganizationSettingsOptions({
      organizationId: user?.activeOrganizationId ?? null,
      userId: user?.id ?? "",
    }),
    retry: false,
    staleTime: 30_000,
  });
  const view = useQueryView(query);
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
