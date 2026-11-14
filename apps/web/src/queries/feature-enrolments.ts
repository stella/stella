import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { chatKeys } from "@/features/chat/chat-query-contract";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { queryView } from "@/lib/query-view.logic";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";

type SelfServeFeatureId = "time-billing" | "local-agents";

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
      unwrapApiResponse(
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
  const view = queryView(useQuery(options));
  const mutation = useMutation({
    mutationFn: async (enrolled: boolean) => {
      const endpoint = api["organization-settings"]["feature-enrolments"]({
        featureId,
      });
      return unwrapApiResponse(
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
              feature.featureId === featureId
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
        queryClient.invalidateQueries({
          queryKey: chatKeys.localRunners(user.activeOrganizationId),
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
