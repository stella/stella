import { useState } from "react";

import { Result } from "better-result";

import { Button } from "@stll/ui/components/button";
import { Skeleton } from "@stll/ui/components/skeleton";
import { Textarea } from "@stll/ui/components/textarea";
import { CopyButton } from "@stll/ui/copy-button";
import {
  AiActionIcon,
  CheckIcon,
  ExternalLinkIcon,
  MailIcon,
  MessageCircleQuestionIcon,
  TextQuoteIcon,
} from "@stll/ui/icons";
import {
  List,
  ListItem,
  ListItemActions,
  ListItemContent,
  ListItemMedia,
  ListItemTitle,
} from "@stll/ui/list";

import { runReplyChecks } from "@/checks";
import { CheckRow } from "@/components/check-row";
import { Notice } from "@/components/notice";
import type { Translate } from "@/components/panel";
import { env } from "@/env";
import type { AssistKind, AssistTurn } from "@/hooks/use-assist";
import type { AskEmailSource } from "@/lib/api-schemas";
import { buildSavedEmailUrl } from "@/lib/saved-email-url";
import { type DraftPlacement, placeDraft } from "@/outlook";
import type { MailSnapshot } from "@/types";

const KIND_ICON = {
  answer: MessageCircleQuestionIcon,
  draft: AiActionIcon,
  summary: TextQuoteIcon,
} as const satisfies Record<AssistKind, unknown>;

const copyText = async (value: string): Promise<boolean> =>
  Result.isOk(
    await Result.tryPromise(
      async () => await navigator.clipboard.writeText(value),
    ),
  );

/**
 * Plain-text paragraphs: blank lines split them, single breaks stay. Each
 * keeps where it starts in the answer, a key no two paragraphs share.
 */
const paragraphs = (text: string): { offset: number; text: string }[] =>
  [...text.matchAll(/[^\n](?:[^\n]|\n(?!\s*\n))*/gu)]
    .map((match) => ({ offset: match.index, text: match[0].trim() }))
    .filter((paragraph) => paragraph.text.length > 0);

/** One thing the assistant was asked, and what came back. */
export const AssistTurnView = ({
  snapshot,
  t,
  turn,
}: {
  snapshot: MailSnapshot;
  t: Translate;
  turn: AssistTurn;
}) => {
  const Icon = KIND_ICON[turn.kind];
  return (
    <article className="flex flex-col gap-2">
      <h3 className="text-muted-foreground flex min-w-0 items-start gap-1.5 px-1 text-xs">
        <Icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        <span className="line-clamp-2 text-pretty">{turn.prompt}</span>
      </h3>
      <TurnBody snapshot={snapshot} t={t} turn={turn} />
    </article>
  );
};

const TurnBody = ({
  snapshot,
  t,
  turn,
}: {
  snapshot: MailSnapshot;
  t: Translate;
  turn: AssistTurn;
}) => {
  const { state } = turn;
  if (state.type === "loading") {
    return (
      <div
        aria-label={t("working")}
        className="grid gap-2.5 px-1 py-1"
        role="status"
      >
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-11/12" />
        <Skeleton className="h-3.5 w-3/4" />
      </div>
    );
  }
  if (state.type === "error") {
    return (
      <Notice role="alert" title={t("aiUnavailable")} tone="risk">
        {state.message}
      </Notice>
    );
  }
  if (turn.kind === "draft") {
    return <DraftBody draft={state.text} snapshot={snapshot} t={t} />;
  }
  return <AnswerBody sources={state.sources} t={t} text={state.text} />;
};

const AnswerBody = ({
  sources,
  t,
  text,
}: {
  sources: AskEmailSource[];
  t: Translate;
  text: string;
}) => (
  <div className="flex flex-col gap-2">
    <div className="flex flex-col gap-2 px-1 text-sm/6 text-pretty">
      {paragraphs(text).map((paragraph) => (
        <p className="whitespace-pre-line" key={paragraph.offset}>
          {paragraph.text}
        </p>
      ))}
    </div>
    {sources.length > 0 ? (
      <List aria-label={t("sources")}>
        {sources.map((source) => (
          <ListItem className="min-h-0 px-3 py-2" key={source.entityId}>
            <ListItemMedia className="size-7 text-xs font-medium tabular-nums">
              {source.number}
            </ListItemMedia>
            <ListItemContent>
              <ListItemTitle>
                <bdi>{source.title}</bdi>
              </ListItemTitle>
            </ListItemContent>
            <ListItemActions>
              <Button
                aria-label={t("openSource", { title: source.title })}
                render={
                  <a
                    href={buildSavedEmailUrl({
                      baseUrl: env.webOrigin,
                      entityId: source.entityId,
                      fieldId: source.fieldId,
                      workspaceId: source.workspaceId,
                    })}
                    rel="noreferrer"
                    target="_blank"
                  />
                }
                size="icon-xs"
                variant="ghost"
              >
                <ExternalLinkIcon />
              </Button>
            </ListItemActions>
          </ListItem>
        ))}
      </List>
    ) : null}
    <div className="flex">
      <CopyButton
        copiedLabel={t("copied")}
        label={t("copy")}
        onCopy={async () => await copyText(text)}
        size="xs"
        variant="ghost"
      />
    </div>
  </div>
);

type Placement =
  | { draft: string; type: "placed"; value: DraftPlacement }
  | { draft: string; message: string; type: "error" };

const DraftBody = ({
  draft: initialDraft,
  snapshot,
  t,
}: {
  draft: string;
  snapshot: MailSnapshot;
  t: Translate;
}) => {
  const [draft, setDraft] = useState(initialDraft);
  const [placement, setPlacement] = useState<Placement | null>(null);
  // A placement reports on the text it placed; editing after it clears it.
  const current = placement?.draft === draft ? placement : null;
  const checks = runReplyChecks({ draft, snapshot, t });

  const place = () => {
    placeDraft(draft)
      .then((value) => setPlacement({ draft, type: "placed", value }))
      .catch((error: unknown) =>
        setPlacement({
          draft,
          message:
            error instanceof Error ? error.message : t("draftPlacementError"),
          type: "error",
        }),
      );
  };

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        aria-label={t("draftLabel")}
        className="text-sm [&_textarea]:min-h-40"
        onChange={(event) => setDraft(event.currentTarget.value)}
        value={draft}
      />
      {checks.length > 0 ? (
        <List aria-label={t("checked")}>
          {checks.map((check) => (
            <CheckRow check={check} key={`${check.type}-${check.title}`} />
          ))}
        </List>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={draft.trim().length === 0} onClick={place} size="sm">
          <MailIcon />
          {snapshot.mode === "compose"
            ? t("insertIntoDraft")
            : t("insertIntoReply")}
        </Button>
        {current?.type === "placed" ? (
          <span
            className="text-muted-foreground inline-flex items-center gap-1.5 text-xs"
            role="status"
          >
            <CheckIcon aria-hidden="true" className="size-3.5" />
            {placementLabel(current.value, t)}
          </span>
        ) : null}
      </div>
      {current?.type === "error" ? (
        <Notice role="alert" title={t("draftPlacementError")} tone="risk">
          {current.message}
        </Notice>
      ) : null}
    </div>
  );
};

const placementLabel = (value: DraftPlacement, t: Translate): string => {
  if (value === "composeBody") {
    return t("insertedIntoDraft");
  }
  if (value === "replyForm") {
    return t("openedReplyDraft");
  }
  return t("copiedToClipboard");
};
