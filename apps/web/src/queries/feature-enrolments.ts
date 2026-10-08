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
import { resetFeatureEnrolmentCache } from "@/queries/feature-enrolments.logic";
import type {
  FeatureEnrolmentsCaller,
  SelfServeFeatureId,
} from "@/queries/feature-enrolments.logic";

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
export const useFeatureEnrolment = (featureId: SelfServeFeatureId) => {
  const user = useAuthenticatedUser();
  const t = useTranslations();
  const queryClient = useQueryClient();
  const options = featureEnrolmentsOptions({
    userId: user.id,
    organizationId: user.activeOrganizationId,
  });
  const view = useQueryView(useQuery(options));
  const mutation = useMutation({
    mutationKey: options.queryKey,
    mutationFn: async (enrolled: boolean) => {
      const endpoint = api["organization-settings"]["feature-enrolments"]({
        featureId,
      });
      return unwrapEden(
        enrolled ? await endpoint.put() : await endpoint.delete(),
      );
    },
    onMutate: async (enrolled) => {
      await queryClient.cancelQueries({ queryKey: options.queryKey });
      const previous = queryClient
        .getQueryData(options.queryKey)
        ?.features.find((feature) => feature.featureId === featureId);
      queryClient.setQueryData(
        options.queryKey,
        (current) =>
          current && {
            ...current,
            features: current.features.map((feature) =>
              feature.featureId === featureId
                ? { ...feature, enrolled }
                : feature,
            ),
          },
      );
      return { previous };
    },
    onError: (error, _enrolled, context) => {
      if (context?.previous) {
        const previous = context.previous;
        queryClient.setQueryData(
          options.queryKey,
          (current) =>
            current && {
              ...current,
              features: current.features.map((feature) =>
                feature.featureId === featureId ? previous : feature,
              ),
            },
        );
      }
      notifyUserError(error, t("errors.actionFailed"));
    },
    onSuccess: () =>
      resetFeatureEnrolmentCache({
        queryClient,
        featureId,
        userId: user.id,
        organizationId: user.activeOrganizationId,
      }),
    onSettled: async () => {
      // Refetch only after the last toggle settles, preserving independent
      // optimistic choices while another feature's request is still pending.
      if (queryClient.isMutating({ mutationKey: options.queryKey }) > 1) {
        return;
      }
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
        feature: view.items.features.find(
          (feature) => feature.featureId === featureId,
        ),
        mutation,
        view,
      };
    default:
      view satisfies never;
      return panic(`Unknown query view: ${String(view)}`);
  }
};

export const useTimeBillingEnrolment = () =>
  useFeatureEnrolment("time-billing");
