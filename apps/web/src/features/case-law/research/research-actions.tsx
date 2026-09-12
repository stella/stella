import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { CASE_LAW_RESEARCH_TABLE_NAME_MAX_LENGTH } from "@stll/api-contract";
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
 * save the current search as a new table and land in it, or open the list.
 * Anonymous readers see nothing; the public page stays as it is for them.
 *
 * The leading separator belongs here rather than to the toolbar around it:
 * the whole group disappears for an anonymous reader, and a toolbar that drew
 * the rule itself would leave it hanging after the column chooser.
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
          // A search may be longer than a name; the words still identify the
          // table and can be renamed in place.
          name: query.slice(0, CASE_LAW_RESEARCH_TABLE_NAME_MAX_LENGTH),
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
    <>
      <span className="bg-border mx-1 h-4 w-px" />
      {search.length > 0 && (
        <Button
          className="h-7 min-h-0 text-xs"
          disabled={create.isPending}
          onClick={() => {
            detached(
              create.mutateAsync(search),
              "research-table.create-from-search",
            );
          }}
          size="sm"
          variant="outline"
        >
          {t("caseLaw.research.save")}
        </Button>
      )}
      <Button
        className="text-muted-foreground h-7 min-h-0 text-xs"
        render={<Link to="/law/cases/research" />}
        size="sm"
        variant="ghost"
      >
        {t("caseLaw.research.title")}
      </Button>
    </>
  );
};
