import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { unwrapEden } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { useQueryView } from "@/lib/use-query-view";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";

const TIME_BILLING_FEATURE_ID = "time-billing";

// Takes a plain string: time billing is the only self-serve feature today, so
// the endpoint's id type is that one literal, but the list is the contract and
// the next feature must not be treated as this one.
const isTimeBillingFeature = (featureId: string): boolean =>
  featureId === TIME_BILLING_FEATURE_ID;

type FeatureEnrolmentsCaller = {
  userId: string;
  organizationId: string;
};

export const featureEnrolmentsOptions = ({
  userId,
  organizationId,
}: FeatureEnrolmentsCaller) =>
  queryOptions({
    queryKey: ["feature-enrolments", userId, organizationId] as const,
    queryFn: async ({ signal }) =>
      unwrapEden(
        await api["organization-settings"]["feature-enrolments"].get({
          fetch: { signal },
        }),
      ),
  });

/** The endpoint lists only self-serve features offered by this deployment. */
export const useTimeBillingEnrolment = () => {
  const user = useAuthenticatedUser();
  const t = useTranslations();
  const queryClient = useQueryClient();
  const options = featureEnrolmentsOptions({
    userId: user.id,
    organizationId: user.activeOrganizationId,
  });
  const view = useQueryView(useQuery(options));
  const mutation = useMutation({
    mutationFn: async (enrolled: boolean) => {
      const endpoint = api["organization-settings"]["feature-enrolments"]({
        featureId: TIME_BILLING_FEATURE_ID,
      });
      return unwrapEden(
        enrolled ? await endpoint.put() : await endpoint.delete(),
      );
    },
    onMutate: async (enrolled) => {
      await queryClient.cancelQueries({ queryKey: options.queryKey });
      const previous = queryClient.getQueryData(options.queryKey);
      queryClient.setQueryData(
        options.queryKey,
        (current) =>
          current && {
            ...current,
            features: current.features.map((feature) =>
              isTimeBillingFeature(feature.featureId)
                ? { ...feature, enrolled }
                : feature,
            ),
          },
      );
      return { previous };
    },
    onError: (error, _enrolled, context) => {
      if (context) {
        queryClient.setQueryData(options.queryKey, context.previous);
      }
      notifyUserError(error, t("errors.actionFailed"));
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: options.queryKey }),
        queryClient.invalidateQueries({
          queryKey: workspacesNavigationOptions({
            userId: user.id,
            organizationId: user.activeOrganizationId,
          }).queryKey,
        }),
      ]);
    },
  });
  switch (view.type) {
    case "pending":
    case "error":
    case "empty":
      return { feature: undefined, mutation, view };
    case "items":
      return {
        feature: view.items.features.find((feature) =>
          isTimeBillingFeature(feature.featureId),
        ),
        mutation,
        view,
      };
    default:
      view satisfies never;
      return panic(`Unknown query view: ${String(view)}`);
  }
};
