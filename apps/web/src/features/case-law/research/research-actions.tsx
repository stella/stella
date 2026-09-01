import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { stellaToast } from "@stll/ui/toast";

import type { DecisionListFilters } from "@/features/case-law/queries/decisions";
import {
  decisionFiltersToSavedQuery,
  researchTableKeys,
} from "@/features/case-law/research/queries";
import { useClientAuthStatus } from "@/hooks/use-client-auth-status";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";

type ResearchTableActionsProps = {
  filters: DecisionListFilters;
};

/**
 * The signed-in reader's way into research tables from the public search:
 * open the list, or save the current search as a new table and land in it.
 * Anonymous readers see nothing; the public page stays as it is for them.
 */
export const ResearchTableActions = ({
  filters,
}: ResearchTableActionsProps) => {
  const t = useTranslations();
  const authStatus = useClientAuthStatus();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const analytics = useAnalytics();
  const search = filters.search?.trim() ?? "";

  const create = useMutation({
    mutationFn: async (query: string) =>
      unwrapEden(
        await api.case.research.post({
          name: query,
          savedQuery: decisionFiltersToSavedQuery({
            ...filters,
            search: query,
          }),
        }),
      ),
    onSuccess: async (table) => {
      await queryClient.invalidateQueries({ queryKey: researchTableKeys.all });
      stellaToast.add({ title: t("caseLaw.research.saved"), type: "success" });
      await navigate({
        to: "/law/cases/research/$tableId",
        params: { tableId: table.id },
      });
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({
        title: t("common.somethingWentWrong"),
        type: "error",
      });
    },
  });

  if (!authStatus.isAuthenticated) {
    return null;
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        render={<Link to="/law/cases/research" />}
        size="sm"
        variant="ghost"
      >
        {t("caseLaw.research.title")}
      </Button>
      {search.length > 0 && (
        <Button
          disabled={create.isPending}
          onClick={() => {
            detached(
              create.mutateAsync(search),
              "case-law.research.create-from-search",
            );
          }}
          size="sm"
          variant="outline"
        >
          {t("caseLaw.research.save")}
        </Button>
      )}
    </div>
  );
};
