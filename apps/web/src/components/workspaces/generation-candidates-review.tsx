/**
 * The review of one generation run's proposed list items: each candidate with
 * the passage it quotes, accepted or declined one at a time or all at once.
 * The lists page and AVT's anchor facts both review candidates here.
 */

import type { ReactElement, ReactNode } from "react";
import { Fragment, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { CheckCheckIcon } from "@stll/ui/icons";
import {
  List,
  ListGroup,
  ListGroupAction,
  ListGroupCount,
  ListGroupDescription,
  ListGroupHeader,
  ListGroupHeading,
  ListGroupTitle,
  ListItem,
  ListItemContent,
  ListItemTitle,
} from "@stll/ui/list";
import { ReviewDecisionActions } from "@stll/ui/review-decision-actions";
import type { ReviewDecisionState } from "@stll/ui/review-decision-actions";
import { ScrollArea } from "@stll/ui/scroll-area";

import {
  acceptAllTargets,
  reviewableCandidates,
} from "@/components/workspaces/generation-candidates-review.logic";
import type { GenerationCandidate } from "@/components/workspaces/generation-candidates-review.logic";
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

/** Where each candidate status stands in the shared review chrome. */
const DECISION_STATE = {
  pending: "pending",
  accepting: "applying",
  accepted: "accepted",
  rejected: "rejected",
} as const satisfies Record<GenerationCandidate["status"], ReviewDecisionState>;

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
 * refusal, leaving the rest for the reviewer. Each resolves to how many
 * candidates it accepted, or `null` when a request was refused.
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
    const sent = await Result.tryPromise(async () =>
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
          }),
    );
    if (sent.isErr()) {
      return Result.err(sent.error);
    }
    return sent.value.error
      ? Result.err(toAPIError(sent.value.error))
      : Result.ok(undefined);
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

  const decide = async (
    candidateId: string,
    decision: CandidateDecision,
  ): Promise<number | null> => {
    if (progress.type !== "idle") {
      return null;
    }
    setProgress({ type: "one", candidateId });
    const result = await send(candidateId, decision);
    setProgress({ type: "idle" });
    if (result.isErr()) {
      report(result.error);
    }
    await refresh();
    if (result.isErr()) {
      return null;
    }
    return decision === "accept" ? 1 : 0;
  };

  const acceptAll = async (
    candidateIds: readonly string[],
  ): Promise<number | null> => {
    if (progress.type !== "idle" || candidateIds.length === 0) {
      return null;
    }
    let accepted = 0;
    for (const [index, candidateId] of candidateIds.entries()) {
      setProgress({ type: "all", done: index, total: candidateIds.length });
      // Sequential on purpose: each acceptance creates a list item, and the
      // first refusal should stop the batch rather than race the rest.
      const result = await send(candidateId, "accept");
      if (result.isErr()) {
        report(result.error);
        break;
      }
      accepted += 1;
    }
    setProgress({ type: "idle" });
    await refresh();
    return accepted === candidateIds.length ? accepted : null;
  };

  return { progress, decide, acceptAll };
};

/** What a run came to once its last candidate was decided here. */
export type CandidateReviewSummary = { proposed: number; accepted: number };

/** Item-type detail for one candidate: a status and quiet facts about it. */
export type CandidateMeta = {
  /** Shown before the quote's source, e.g. a held fact and why. */
  status: ReactNode;
  /** One quiet line of labels; the source document is appended. */
  parts: ReactElement[];
};

type GenerationCandidatesReviewProps = {
  workspaceId: string;
  listId: string;
  runId: string;
  /** Every candidate of the run; decided ones are left out here. */
  candidates: readonly GenerationCandidate[];
  title: string;
  description?: ReactNode;
  /** `strip` scrolls cards sideways under a page header; `list` stacks rows. */
  layout: "strip" | "list";
  canDecide: boolean;
  renderMeta?: (candidate: GenerationCandidate) => CandidateMeta;
  onReviewFinished?: (summary: CandidateReviewSummary) => void;
};

export const GenerationCandidatesReview = ({
  workspaceId,
  listId,
  runId,
  candidates,
  title,
  description,
  layout,
  canDecide,
  renderMeta,
  onReviewFinished,
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
  // Until the files load (or if they cannot), a source shows as "Document".
  const documentName = (entityId: string): string | null => {
    if (filesView.type !== "items") {
      return null;
    }
    const file = filesView.items.find((entry) => entry.entityId === entityId);
    return file === undefined ? null : (file.name ?? file.fileName);
  };

  const open = reviewableCandidates(candidates);
  if (open.length === 0) {
    return null;
  }
  const toAccept = acceptAllTargets(open);
  const busy = progress.type !== "idle";
  const alreadyAccepted = candidates.filter(
    (candidate) => candidate.status === "accepted",
  ).length;
  // Reported only when this page decided the last open candidate; another
  // reviewer's decisions arrive through the refreshed run instead.
  const finish = (accepted: number | null, decided: number) => {
    if (accepted === null || decided < open.length) {
      return;
    }
    onReviewFinished?.({
      proposed: candidates.length,
      accepted: alreadyAccepted + accepted,
    });
  };

  const decideOne = async (
    candidateId: string,
    decision: CandidateDecision,
  ) => {
    finish(await decide(candidateId, decision), 1);
  };

  const rows = open.map((candidate) => {
    const body = (
      <CandidateBody
        candidate={candidate}
        documentName={documentName}
        meta={renderMeta?.(candidate)}
        workspaceId={workspaceId}
      />
    );
    const actions = (
      <ReviewDecisionActions
        acceptLabel={t("common.accept")}
        className="shrink-0"
        disabled={!canDecide || busy}
        emphasis="quiet"
        onAccept={() => {
          detached(
            decideOne(candidate.id, "accept"),
            "lists.decide-generation-candidate",
          );
        }}
        onReject={() => {
          detached(
            decideOne(candidate.id, "reject"),
            "lists.decide-generation-candidate",
          );
        }}
        rejectLabel={t("common.decline")}
        size="sm"
        state={
          progress.type === "one" && progress.candidateId === candidate.id
            ? "applying"
            : DECISION_STATE[candidate.status]
        }
      />
    );
    return layout === "strip" ? (
      <article
        className="bg-background flex w-80 shrink-0 flex-col gap-2 rounded-lg border p-3"
        key={candidate.id}
      >
        {body}
        <div className="flex justify-end">{actions}</div>
      </article>
    ) : (
      <ListItem
        className="flex-col items-stretch sm:flex-row sm:items-start"
        key={candidate.id}
      >
        {body}
        {actions}
      </ListItem>
    );
  });

  const showAcceptAll = canDecide && toAccept.length > 1;
  const acceptAllButton = showAcceptAll && (
    <Button
      disabled={busy}
      loading={progress.type === "all"}
      onClick={() => {
        detached(
          (async () => {
            finish(await acceptAll(toAccept), toAccept.length);
          })(),
          "lists.accept-all-generation-candidates",
        );
      }}
      size="sm"
      variant={layout === "list" ? "default" : "outline"}
    >
      <CheckCheckIcon />
      {progress.type === "all"
        ? t("lists.candidates.accepting", {
            done: format.number(progress.done),
            total: format.number(progress.total),
          })
        : t("docxReview.acceptAll")}
    </Button>
  );

  if (layout === "strip") {
    return (
      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-muted-foreground min-w-0 text-xs font-medium">
            {title}
          </p>
          {acceptAllButton}
        </div>
        <ScrollArea>
          <div className="flex gap-2 pb-2">{rows}</div>
        </ScrollArea>
      </section>
    );
  }
  return (
    <ListGroup>
      <ListGroupHeader>
        <ListGroupHeading>
          <ListGroupTitle>
            {title}
            <ListGroupCount count={format.number(open.length)} />
          </ListGroupTitle>
          {description !== undefined && (
            <ListGroupDescription>{description}</ListGroupDescription>
          )}
        </ListGroupHeading>
        {showAcceptAll && <ListGroupAction>{acceptAllButton}</ListGroupAction>}
      </ListGroupHeader>
      <List>{rows}</List>
    </ListGroup>
  );
};

type CandidateBodyProps = {
  workspaceId: string;
  candidate: GenerationCandidate;
  meta: CandidateMeta | undefined;
  documentName: (entityId: string) => string | null;
};

/**
 * The proposal, then the passage it rests on, then one quiet line saying what
 * kind of item it is and where the passage sits.
 */
const CandidateBody = ({
  workspaceId,
  candidate,
  meta,
  documentName,
}: CandidateBodyProps) => {
  const openSourceDocument = useOpenSourceDocument(workspaceId);
  const source = candidate.sources.at(0);
  const parts = meta === undefined ? [] : [...meta.parts];
  if (source !== undefined) {
    parts.push(
      <Button
        className="min-w-0"
        key="source"
        onClick={() =>
          openSourceDocument(
            source.sourceEntityId,
            sourceLocatorPage(source.locator),
          )
        }
        size="inline"
        variant="link"
      >
        <span className="truncate">
          <SourceLocatorLabel
            documentName={documentName(source.sourceEntityId)}
            locator={source.locator}
          />
        </span>
      </Button>,
    );
  }
  return (
    <ListItemContent>
      <ListItemTitle variant="statement">{candidate.name}</ListItemTitle>
      {candidate.description && (
        <p className="text-muted-foreground line-clamp-2 text-xs" dir="auto">
          {candidate.description}
        </p>
      )}
      {source !== undefined && source.quote !== null && (
        <p
          className="text-foreground mt-1 line-clamp-3 text-sm leading-relaxed text-pretty"
          dir="auto"
        >
          <q>
            <BidiText as="span">{source.quote}</BidiText>
          </q>
        </p>
      )}
      {meta?.status}
      {parts.length > 0 && (
        <div className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
          {parts.map((part, index) => (
            <Fragment key={part.key}>
              {index > 0 && <span aria-hidden="true">·</span>}
              {part}
            </Fragment>
          ))}
        </div>
      )}
    </ListItemContent>
  );
};
