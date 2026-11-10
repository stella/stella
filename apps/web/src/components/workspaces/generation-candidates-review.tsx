/**
 * The review of one generation run's proposed list items: each candidate with
 * the passages it cites, accepted or declined one at a time or all at once.
 * The lists page and AVT's anchor facts both review candidates here.
 */

import type { ReactNode } from "react";
import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { CheckCheckIcon } from "@stll/ui/icons";
import { ReviewDecisionActions } from "@stll/ui/review-decision-actions";
import { ScrollArea } from "@stll/ui/scroll-area";
import { cn } from "@stll/ui/utils";

import {
  acceptAllTargets,
  reviewableCandidates,
} from "@/components/workspaces/generation-candidates-review.logic";
import type {
  GenerationCandidate,
  GenerationCandidateSource,
} from "@/components/workspaces/generation-candidates-review.logic";
import {
  SourceLocatorLabel,
  sourceLocatorPage,
  useOpenSourceDocument,
} from "@/components/workspaces/list-source";
import { useFormatter } from "@/i18n/formatting-context";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { toAPIError } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { useIdempotentSubmit } from "@/lib/idempotency/use-idempotent-submit";
import { queryView } from "@/lib/query-view.logic";
import { toSafeId } from "@/lib/safe-id";
import { workspaceFilesOptions } from "@/lib/workspaces/queries/entities";
import { legalListKeys } from "@/lib/workspaces/queries/legal-lists";

type CandidateDecision = "accept" | "reject";

type DecisionProgress =
  | { type: "idle" }
  | { type: "one"; candidateId: string }
  | { type: "all"; done: number; total: number };

type CandidateDecisionsArgs = {
  workspaceId: string;
  listId: string;
  runId: string;
};

/**
 * Accept or decline a run's candidates. One decision runs at a time; "accept
 * all" accepts the undecided ones in proposal order and stops at the first
 * refusal, leaving the rest for the reviewer.
 */
export const useGenerationCandidateDecisions = ({
  workspaceId,
  listId,
  runId,
}: CandidateDecisionsArgs) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const submit = useIdempotentSubmit();
  const [progress, setProgress] = useState<DecisionProgress>({
    type: "idle",
  });

  const send = async (candidateId: string, decision: CandidateDecision) => {
    const endpoint = api.lists({
      workspaceId: toSafeId<"workspace">(workspaceId),
    })["generation-candidates"];
    const body = {
      listId: toSafeId<"legalList">(listId),
      runId: toSafeId<"legalListGenerationRun">(runId),
      candidateId: toSafeId<"legalListGenerationCandidate">(candidateId),
    };
    return await Result.tryPromise(async () => {
      const response =
        decision === "accept"
          ? await submit.run({
              operation: `lists.generation-candidates.accept:${workspaceId}`,
              body,
              send: endpoint.accept.post,
            })
          : await submit.run({
              operation: `lists.generation-candidates.reject:${workspaceId}`,
              body,
              send: endpoint.reject.post,
            });
      if (response.error) {
        throw toAPIError(response.error);
      }
    });
  };

  const report = (error: unknown) => {
    getAnalytics().captureError(error, {
      fingerprintKey: "GenerationCandidatesReview.decide:failure",
      scope: {
        type: "handler",
        handlerId: "GenerationCandidatesReview.decide:failure",
      },
    });
    notifyUserError(error, t("errors.actionFailed"));
  };

  // A refused decision may mean the candidate moved on elsewhere, so the
  // run, its candidates and the list are re-read either way.
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: legalListKeys.items(workspaceId, listId),
      }),
      queryClient.invalidateQueries({
        queryKey: legalListKeys.generations(workspaceId, listId),
      }),
    ]);
  };

  const decide = async (candidateId: string, decision: CandidateDecision) => {
    if (progress.type !== "idle") {
      return;
    }
    setProgress({ type: "one", candidateId });
    const result = await send(candidateId, decision);
    setProgress({ type: "idle" });
    if (result.isErr()) {
      report(result.error);
    }
    await refresh();
  };

  const acceptAll = async (candidateIds: readonly string[]) => {
    if (progress.type !== "idle" || candidateIds.length === 0) {
      return;
    }
    for (const [index, candidateId] of candidateIds.entries()) {
      setProgress({ type: "all", done: index, total: candidateIds.length });
      // Sequential on purpose: each acceptance creates a list item, and the
      // first refusal should stop the batch rather than race the rest.
      const result = await send(candidateId, "accept");
      if (result.isErr()) {
        report(result.error);
        break;
      }
    }
    setProgress({ type: "idle" });
    await refresh();
  };

  return { progress, decide, acceptAll };
};

type GenerationCandidatesReviewProps = {
  workspaceId: string;
  listId: string;
  runId: string;
  /** Every candidate of the run; decided ones are left out here. */
  candidates: readonly GenerationCandidate[];
  title: ReactNode;
  /** `strip` scrolls cards sideways under a page header; `stack` lists them. */
  layout: "strip" | "stack";
  canDecide: boolean;
  /** Item-type detail shown under a candidate's text (a fact's date, …). */
  renderDetails?: (candidate: GenerationCandidate) => ReactNode;
  className?: string;
};

export const GenerationCandidatesReview = ({
  workspaceId,
  listId,
  runId,
  candidates,
  title,
  layout,
  canDecide,
  renderDetails,
  className,
}: GenerationCandidatesReviewProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const { progress, decide, acceptAll } = useGenerationCandidateDecisions({
    workspaceId,
    listId,
    runId,
  });
  const filesQuery = useQuery(workspaceFilesOptions(workspaceId));
  const filesView = queryView(filesQuery);
  const files = filesView.type === "items" ? filesView.items : [];
  const documentName = (entityId: string): string | null => {
    const file = files.find((entry) => entry.entityId === entityId);
    return file === undefined ? null : (file.name ?? file.fileName);
  };

  const open = reviewableCandidates(candidates);
  if (open.length === 0) {
    return null;
  }
  const toAccept = acceptAllTargets(open);
  const busy = progress.type !== "idle";

  const cards = open.map((candidate) => (
    <CandidateCard
      busy={busy}
      canDecide={canDecide}
      candidate={candidate}
      documentName={documentName}
      key={candidate.id}
      layout={layout}
      onDecide={(decision) => {
        detached(
          decide(candidate.id, decision),
          "lists.decide-generation-candidate",
        );
      }}
      renderDetails={renderDetails}
      deciding={
        progress.type === "one" && progress.candidateId === candidate.id
      }
      workspaceId={workspaceId}
    />
  ));

  return (
    <section className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-muted-foreground min-w-0 text-xs font-medium">
          {title}
        </div>
        {canDecide && toAccept.length > 1 && (
          <Button
            loading={progress.type === "all"}
            disabled={busy}
            onClick={() => {
              detached(
                acceptAll(toAccept),
                "lists.accept-all-generation-candidates",
              );
            }}
            size="sm"
            variant="outline"
          >
            <CheckCheckIcon />
            {progress.type === "all"
              ? t("lists.candidates.accepting", {
                  done: format.number(progress.done),
                  total: format.number(progress.total),
                })
              : t("docxReview.acceptAll")}
          </Button>
        )}
      </div>
      {layout === "strip" ? (
        <ScrollArea>
          <div className="flex gap-2 pb-2">{cards}</div>
        </ScrollArea>
      ) : (
        <ul className="bg-background divide-y rounded-xl border">{cards}</ul>
      )}
    </section>
  );
};

type CandidateCardProps = {
  workspaceId: string;
  candidate: GenerationCandidate;
  layout: "strip" | "stack";
  canDecide: boolean;
  busy: boolean;
  deciding: boolean;
  documentName: (entityId: string) => string | null;
  renderDetails: ((candidate: GenerationCandidate) => ReactNode) | undefined;
  onDecide: (decision: CandidateDecision) => void;
};

const CandidateCard = ({
  workspaceId,
  candidate,
  layout,
  canDecide,
  busy,
  deciding,
  documentName,
  renderDetails,
  onDecide,
}: CandidateCardProps) => {
  const t = useTranslations();
  const content = (
    <>
      <p
        className="text-sm leading-snug font-medium text-pretty wrap-break-word"
        dir="auto"
      >
        {candidate.name}
      </p>
      {candidate.description && (
        <p className="text-muted-foreground line-clamp-2 text-xs" dir="auto">
          {candidate.description}
        </p>
      )}
      {renderDetails?.(candidate)}
      <CandidateSources
        documentName={documentName}
        sources={candidate.sources}
        workspaceId={workspaceId}
      />
    </>
  );
  const actions = (
    <ReviewDecisionActions
      acceptLabel={t("common.accept")}
      className="shrink-0 justify-end"
      disabled={!canDecide || busy}
      onAccept={() => onDecide("accept")}
      onReject={() => onDecide("reject")}
      rejectLabel={t("common.decline")}
      size="sm"
      state={
        deciding || candidate.status === "accepting" ? "applying" : "pending"
      }
    />
  );
  // A card in the sideways strip keeps its actions underneath; a row in the
  // list puts them beside the text once there is room.
  return layout === "strip" ? (
    <article className="bg-background flex w-80 shrink-0 flex-col gap-1.5 rounded-lg border p-3">
      {content}
      {actions}
    </article>
  ) : (
    <li className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-start sm:gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">{content}</div>
      {actions}
    </li>
  );
};

type CandidateSourcesProps = {
  workspaceId: string;
  sources: readonly GenerationCandidateSource[];
  documentName: (entityId: string) => string | null;
};

/** The passages a candidate cites, each with the document page it is on. */
const CandidateSources = ({
  workspaceId,
  sources,
  documentName,
}: CandidateSourcesProps) => {
  const t = useTranslations();
  const openSourceDocument = useOpenSourceDocument(workspaceId);
  if (sources.length === 0) {
    return null;
  }
  return (
    <ul className="space-y-1.5">
      {sources.map((source) => (
        <li className="min-w-0 space-y-0.5" key={source.id}>
          {source.quote !== null && (
            <blockquote
              aria-label={t("inbox.evidence.quote")}
              className="text-muted-foreground border-s-2 ps-2 text-xs leading-relaxed text-pretty wrap-break-word"
              dir="auto"
            >
              <BidiText as="span" className="line-clamp-4">
                {source.quote}
              </BidiText>
            </blockquote>
          )}
          <Button
            className="max-w-full min-w-0 justify-start"
            onClick={() =>
              openSourceDocument(
                source.sourceEntityId,
                sourceLocatorPage(source.locator),
              )
            }
            size="xs"
            variant="link"
          >
            <span className="truncate">
              <SourceLocatorLabel
                documentName={documentName(source.sourceEntityId)}
                locator={source.locator}
              />
            </span>
          </Button>
        </li>
      ))}
    </ul>
  );
};
