import { useState } from "react";

import { OUTLOOK_AI_INTENT_MAX_CHARS } from "@stll/api-contract/outlook-ai";
import { Button } from "@stll/ui/components/button";
import { Textarea } from "@stll/ui/components/textarea";
import {
  COMPOSER_BOX_CLASS,
  COMPOSER_BOX_FOCUS_CLASS,
  COMPOSER_LARGE_ACTION_ROW_CLASS,
  COMPOSER_LARGE_TEXT_WELL_CLASS,
  COMPOSER_LEADING_GROUP_CLASS,
  COMPOSER_SEND_BUTTON_CLASS,
  COMPOSER_TEXT_CLASS,
} from "@stll/ui/composer";
import { AiActionIcon, ArrowUpIcon, InfoIcon } from "@stll/ui/icons";
import { cn } from "@stll/ui/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";

import { AssistTurnView } from "@/components/assist-turn";
import { Panel } from "@/components/panel";
import type { Translate } from "@/components/panel";
import type { AssistKind, AssistTurn } from "@/hooks/assist-turns.logic";
import type { MailSnapshot, WorkspaceSummary } from "@/types";

type AssistSectionProps = {
  isBusy: boolean;
  /** The matter whose documents answers draw on, when there is one. */
  matter: WorkspaceSummary | null;
  onAsk: (args: {
    instruction: string;
    kind: AssistKind;
    prompt: string;
  }) => void;
  /** Sends a failed turn's request again. */
  onRetry: (turnId: string) => void;
  snapshot: MailSnapshot;
  t: Translate;
  turns: AssistTurn[];
};

/**
 * One box for everything the assistant does with the email: ask a question,
 * or say what the reply should say and draft it. Quick actions cover the
 * common asks; results stack underneath, newest first.
 */
export const AssistSection = ({
  isBusy,
  matter,
  onAsk,
  onRetry,
  snapshot,
  t,
  turns,
}: AssistSectionProps) => {
  const [text, setText] = useState("");
  const typed = text.trim();
  const hasBody = snapshot.bodyText.trim().length > 0;

  const submit = (kind: AssistKind) => {
    if (kind === "summary") {
      onAsk({ instruction: "", kind, prompt: t("summarize") });
      return;
    }
    if (kind === "draft") {
      onAsk({
        instruction: typed || t("draftDefaultIntent"),
        kind,
        prompt: typed || t("draftReply"),
      });
      setText("");
      return;
    }
    if (typed.length === 0) {
      return;
    }
    onAsk({ instruction: typed, kind, prompt: typed });
    setText("");
  };

  return (
    <Panel
      action={
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={t("aiDataNoticeLabel")}
                size="icon-xs"
                variant="ghost"
              />
            }
          >
            <InfoIcon />
          </TooltipTrigger>
          <TooltipPopup className="max-w-64">{t("aiDataNotice")}</TooltipPopup>
        </Tooltip>
      }
      title={t("assistTitle")}
    >
      <div className={cn(COMPOSER_BOX_CLASS, COMPOSER_BOX_FOCUS_CLASS)}>
        <div className={COMPOSER_LARGE_TEXT_WELL_CLASS}>
          <Textarea
            aria-label={t("askLabel")}
            className={cn(
              COMPOSER_TEXT_CLASS,
              // The composer's three-line editor, on the field inside.
              "block w-full [&_textarea]:max-h-48 [&_textarea]:min-h-15 [&_textarea]:resize-none [&_textarea]:px-0",
            )}
            maxLength={OUTLOOK_AI_INTENT_MAX_CHARS}
            onChange={(event) => setText(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                submit("answer");
              }
            }}
            placeholder={t("askPlaceholder")}
            unstyled
            value={text}
          />
        </div>
        <div className={COMPOSER_LARGE_ACTION_ROW_CLASS}>
          <div className={cn(COMPOSER_LEADING_GROUP_CLASS, "me-auto")}>
            <Button
              disabled={!hasBody}
              onClick={() => submit("summary")}
              size="xs"
              variant="ghost"
            >
              {t("summarize")}
            </Button>
            <Button onClick={() => submit("draft")} size="xs" variant="ghost">
              <AiActionIcon />
              {t("draftReply")}
            </Button>
          </div>
          <Button
            aria-label={t("ask")}
            className={COMPOSER_SEND_BUTTON_CLASS}
            disabled={typed.length === 0}
            onClick={() => submit("answer")}
            size="icon-sm"
          >
            <ArrowUpIcon />
          </Button>
        </div>
      </div>
      <p className="text-muted-foreground text-2xs truncate px-1">
        {matter
          ? t.rich("groundedIn", {
              matter: (chunks) => (
                <bdi className="text-foreground">{chunks}</bdi>
              ),
              matterName: matter.name,
            })
          : t("groundedInEmailOnly")}
      </p>
      {turns.length > 0 ? (
        <div aria-busy={isBusy} className="flex flex-col gap-5 pt-2">
          {turns.map((turn) => (
            <AssistTurnView
              key={turn.id}
              onRetry={() => onRetry(turn.id)}
              snapshot={snapshot}
              t={t}
              turn={turn}
            />
          ))}
        </div>
      ) : null}
    </Panel>
  );
};
