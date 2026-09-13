import { useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Trash2Icon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { stellaToast } from "@stll/ui/toast";

import { DecisionTable } from "@/features/case-law/components/decision-table";
import type {
  Decision,
  DecisionExtraColumn,
} from "@/features/case-law/components/decision-table";
import { useDecisionColumnPreferences } from "@/features/case-law/decision-column-preferences";
import {
  matterLinkKeys,
  matterLinksOptions,
  unlinkDecisionFromMatter,
} from "@/features/case-law/matter-links/queries";
import type { MatterDecisionLink } from "@/features/case-law/matter-links/queries";
import { openDecisionAtPassage } from "@/features/case-law/open-decision-at-passage";
import {
  QuestionColumnControls,
  useQuestionColumns,
} from "@/features/case-law/research/question-columns-controller";
import { useHasMounted } from "@/hooks/use-chrome-query";
import { useAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";

const NOTE_COLUMN_ID = "matterLinkNote";
const UNLINK_COLUMN_ID = "matterLinkRemove";
const EMPTY_SELECTION: readonly string[] = [];

/**
 * The case law a matter keeps.
 *
 * The same table as the public results — same cells, same organisation
 * question columns and answers — so a decision reads identically wherever it
 * is met, plus what only a matter knows: the note it was pinned with, and the
 * way back out.
 */
export const MatterCaseLawPanel = ({
  workspaceId,
}: {
  workspaceId: string;
}) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // The matter's links are their own read: the overview payload is the
  // workspace slice's entity summary, and folding a three-table case-law join
  // into it would make every matter pay for decisions it has none of. So one
  // bounded request, off the route's critical path — not in the loader, and
  // held until after paint so the overview finishes its round first.
  const hasMounted = useHasMounted();
  const { data: links = NO_LINKS, isLoading: isLoadingLinks } = useQuery({
    ...matterLinksOptions({ workspaceId }),
    enabled: hasMounted,
  });
  // A disabled query reports no loading, so without the gate the empty state
  // would flash in the window between paint and the first response.
  const isLoading = !hasMounted || isLoadingLinks;
  const hasLinks = links.length > 0;
  // Linked decisions come from every jurisdiction the matter touched, so the
  // arrangement is the one the reader keeps for mixed listings rather than a
  // per-country one.
  const { layout, setLayout } = useDecisionColumnPreferences(MATTER_SCOPE);
  const [selectedIds, setSelectedIds] =
    useState<readonly string[]>(EMPTY_SELECTION);

  // Keyed by the row's own id rather than the link's, so the lookup a cell
  // makes is the key the row was built with and the two cannot drift apart.
  const rows = links.map((link) => ({ decision: toDecision(link), link }));
  const decisions = rows.map((row) => row.decision);
  const linkByDecisionId = new Map(
    rows.map((row) => [row.decision.id, row.link]),
  );

  const questions = useQuestionColumns({
    // The organization's questions are only worth reading once the matter has
    // a decision to ask them of; a matter with nothing linked asks nothing.
    enabled: hasLinks,
    onShowSource: (decision, anchorId) => {
      detached(
        openDecisionAtPassage(navigate, decision, anchorId),
        "matter-case-law.show-source",
      );
    },
    pageDecisionIds: decisions.map((decision) => decision.id),
    selectedDecisionIds: selectedIds,
  });

  const unlink = useMutation({
    mutationFn: async (linkId: string) =>
      await unlinkDecisionFromMatter({ linkId, workspaceId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: matterLinkKeys.list({ workspaceId }),
      });
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({ title: t("common.somethingWentWrong"), type: "error" });
    },
  });

  const extraColumns: readonly DecisionExtraColumn[] = [
    {
      id: NOTE_COLUMN_ID,
      label: t("caseLaw.matterLinks.note"),
      size: 260,
      render: (decision) => linkByDecisionId.get(decision.id)?.note ?? "—",
    },
    {
      id: UNLINK_COLUMN_ID,
      label: t("caseLaw.matterLinks.remove"),
      size: 56,
      render: (decision) => {
        const linkId = linkByDecisionId.get(decision.id)?.id;
        if (linkId === undefined) {
          return null;
        }
        return (
          <Button
            aria-label={t("caseLaw.matterLinks.remove")}
            disabled={unlink.isPending}
            onClick={() => {
              detached(unlink.mutateAsync(linkId), "matter-case-law.unlink");
            }}
            size="icon-sm"
            variant="ghost"
          >
            <Trash2Icon aria-hidden="true" className="size-3.5" />
          </Button>
        );
      },
    },
  ];

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">{t("common.caseLaw")}</h2>
        {hasLinks && (
          <div className="flex items-center gap-1">
            <QuestionColumnControls controller={questions} />
          </div>
        )}
      </div>

      {!isLoading && !hasLinks ? (
        <p className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
          {t("caseLaw.matterLinks.empty")}
          <Button
            className="h-7 min-h-0 text-xs"
            render={<Link to="/law/cases" />}
            size="sm"
            variant="outline"
          >
            {t("caseLaw.matterLinks.emptyAction")}
          </Button>
        </p>
      ) : (
        <DecisionTable
          decisions={decisions}
          extraColumns={extraColumns}
          isLoading={isLoading}
          layout={layout}
          onLayoutChange={setLayout}
          onSelectedIdsChange={setSelectedIds}
          order="newest"
          questions={questions.surface}
          selectedIds={selectedIds}
        />
      )}
    </section>
  );
};

const NO_LINKS: readonly MatterDecisionLink[] = [];

/** The arrangement key: a matter's list is not one jurisdiction's. */
const MATTER_SCOPE = "matter";

/**
 * A link's decision as the shared row model draws it. The list endpoint
 * carries the row facts and nothing borrowed: no snippet, because nothing was
 * searched for. The alternates it does carry, because they decide whether the
 * route to the decision names a language at all, and a multilingual decision
 * reached without one resolves to whichever translation the slug lookup picks.
 */
const toDecision = (link: MatterDecisionLink): Decision => ({
  id: link.decision.id,
  caseNumber: link.decision.caseNumber,
  slug: link.decision.slug,
  ecli: link.decision.ecli,
  court: link.decision.court,
  country: link.decision.country,
  language: link.decision.language,
  languageAlternates: link.decision.languageAlternates,
  decisionDate: link.decision.decisionDate,
  decisionType: link.decision.decisionType,
  headnote: link.decision.headnote,
  citationCount: link.decision.citationCount,
});
