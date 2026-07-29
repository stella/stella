import {
  FileTextIcon,
  MailPlusIcon,
  ShieldCheckIcon,
  Wand2Icon,
} from "lucide-react";

import { Button } from "@stll/ui/components/button";
import { Separator } from "@stll/ui/components/separator";
import { Skeleton } from "@stll/ui/components/skeleton";
import { Textarea } from "@stll/ui/components/textarea";

import { CheckRow } from "@/components/check-row";
import { Notice } from "@/components/notice";
import { Panel, PanelTitle } from "@/components/panel";
import type { Translate } from "@/components/panel";
import type { AIDraftState } from "@/hooks/use-ai-draft";
import type { AISummaryState } from "@/hooks/use-ai-summary";
import type { DraftPlacement } from "@/outlook";
import type { DraftCheck } from "@/types";

type ActionPanelProps = {
  canSummarize: boolean;
  checks: DraftCheck[];
  draft: string;
  draftIntent: string;
  draftPlacement: DraftPlacement | null;
  draftState: AIDraftState;
  onDraftChange: (value: string) => void;
  onDraftReply: () => void;
  onIntentChange: (value: string) => void;
  onPlaceDraft: () => void;
  onSummarize: () => void;
  summaryState: AISummaryState;
  t: Translate;
};

export const ActionPanel = ({
  canSummarize,
  checks,
  draft,
  draftIntent,
  draftPlacement,
  draftState,
  onDraftChange,
  onDraftReply,
  onIntentChange,
  onPlaceDraft,
  onSummarize,
  summaryState,
  t,
}: ActionPanelProps) => (
  <Panel>
    <p className="text-muted-foreground text-xs/4.5">{t("aiDataNotice")}</p>

    <SummarySection
      canSummarize={canSummarize}
      onSummarize={onSummarize}
      state={summaryState}
      t={t}
    />

    <Separator />

    <DraftSection
      draft={draft}
      draftIntent={draftIntent}
      draftPlacement={draftPlacement}
      onDraftChange={onDraftChange}
      onDraftReply={onDraftReply}
      onIntentChange={onIntentChange}
      onPlaceDraft={onPlaceDraft}
      state={draftState}
      t={t}
    />

    <Separator />

    <CheckSection checks={checks} t={t} />
  </Panel>
);

const SummarySection = ({
  canSummarize,
  onSummarize,
  state,
  t,
}: {
  canSummarize: boolean;
  onSummarize: () => void;
  state: AISummaryState;
  t: Translate;
}) => (
  <div className="grid gap-2">
    <div className="flex items-center justify-between gap-2">
      <PanelTitle icon={<FileTextIcon />} title={t("summary")} />
      <Button
        disabled={!canSummarize}
        loading={state.type === "loading"}
        onClick={onSummarize}
        size="sm"
        variant="outline"
      >
        <FileTextIcon />
        {t("summarize")}
      </Button>
    </div>
    <SummaryOutput state={state} t={t} />
  </div>
);

const SummaryOutput = ({
  state,
  t,
}: {
  state: AISummaryState;
  t: Translate;
}) => {
  if (state.type === "loading") {
    return (
      <div className="grid gap-1.5" role="status" aria-label={t("summarizing")}>
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-11/12" />
        <Skeleton className="h-3.5 w-3/4" />
      </div>
    );
  }
  if (state.type === "error") {
    return (
      <Notice title={t("aiUnavailable")} tone="risk">
        {state.message}
      </Notice>
    );
  }
  if (state.type === "ready") {
    return (
      <p className="bg-muted/40 border-border rounded-lg border px-3 py-2.5 text-xs/5 whitespace-pre-wrap">
        {state.summary}
      </p>
    );
  }
  return null;
};

const DraftSection = ({
  draft,
  draftIntent,
  draftPlacement,
  onDraftChange,
  onDraftReply,
  onIntentChange,
  onPlaceDraft,
  state,
  t,
}: {
  draft: string;
  draftIntent: string;
  draftPlacement: DraftPlacement | null;
  onDraftChange: (value: string) => void;
  onDraftReply: () => void;
  onIntentChange: (value: string) => void;
  onPlaceDraft: () => void;
  state: AIDraftState;
  t: Translate;
}) => (
  <div className="grid gap-2">
    <PanelTitle icon={<Wand2Icon />} title={t("draftReply")} />
    <Textarea
      aria-label={t("draftReply")}
      onChange={(event) => onIntentChange(event.currentTarget.value)}
      placeholder={t("draftIntentPlaceholder")}
      value={draftIntent}
    />
    <Button
      disabled={draftIntent.trim().length === 0}
      loading={state.type === "loading"}
      onClick={onDraftReply}
      variant="outline"
    >
      <Wand2Icon />
      {t("draftReply")}
    </Button>
    {state.type === "error" ? (
      <Notice title={t("aiUnavailable")} tone="risk">
        {state.message}
      </Notice>
    ) : null}
    <Textarea
      aria-label={t("draftReply")}
      className="min-h-32"
      onChange={(event) => onDraftChange(event.currentTarget.value)}
      value={draft}
    />
    <div className="flex flex-wrap items-center gap-2">
      <Button disabled={!draft} onClick={onPlaceDraft}>
        <MailPlusIcon />
        {t("copyOrInsertDraft")}
      </Button>
      {draftPlacement ? (
        <span className="text-muted-foreground text-xs/4.5">
          {placementLabel(draftPlacement, t)}
        </span>
      ) : null}
    </div>
  </div>
);

const CheckSection = ({
  checks,
  t,
}: {
  checks: DraftCheck[];
  t: Translate;
}) => (
  <div className="grid gap-2">
    <PanelTitle icon={<ShieldCheckIcon />} title={t("checked")} />
    <div className="grid gap-2">
      {checks.map((check) => (
        <CheckRow check={check} key={`${check.type}-${check.title}`} />
      ))}
    </div>
  </div>
);

const placementLabel = (placement: DraftPlacement, t: Translate): string => {
  if (placement === "composeBody") {
    return t("insertedIntoDraft");
  }
  if (placement === "replyForm") {
    return t("openedReplyDraft");
  }
  return t("copiedToClipboard");
};
