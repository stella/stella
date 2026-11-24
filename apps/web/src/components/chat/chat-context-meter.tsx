import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import type {
  ChatHarnessContextUsage,
  ChatLocalRunContext,
} from "@stll/api-contract/chat-run-target";
import { Button } from "@stll/ui/button";
import {
  Popover,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "@stll/ui/popover";
import { cn } from "@stll/ui/utils";

import {
  CHAT_CONTEXT_METER_BOX_CLASS,
  ChatContextMeterPending,
  ContextRing,
} from "@/components/chat/chat-context-meter.pending";
import { useFormatter } from "@/i18n/formatting-context";

/** Model-context estimate for a chat thread's next send, as returned by the
 *  chat-messages endpoint. The five breakdown parts sum to `estimatedTokens`,
 *  so the segmented bar renders without any reconciliation. `cacheStableTokens`
 *  (= prompt + tools) is the prompt-cache-stable prefix. */
export type ChatContextEstimate = {
  source: "estimate";
  estimatedTokens: number;
  triggerTokens: number;
  cacheStableTokens: number;
  summarizedMessageCount: number;
  breakdown: {
    promptTokens: number;
    toolTokens: number;
    summaryTokens: number;
    attachmentTokens: number;
    conversationTokens: number;
  };
};

/**
 * What the meter shows: stella's estimate for a thread on its own models, or
 * for a thread whose turns run on the member's computer, only what its
 * harness reported.
 */
export type ChatContextUsage = ChatContextEstimate | ChatHarnessContextUsage;

type ChatContextMeterProps =
  | { status: "pending" }
  | {
      status: "ready";
      /**
       * The next-send estimate, or `null` before the first message lands.
       * A brand-new thread still renders the meter as an empty ring,
       * so the affordance is present from the start; only the breakdown
       * popover is withheld until there is a conversation to break down.
       */
      usage: ChatContextUsage | null;
    };

// The ring's tone escalates near the trigger.
const WARNING_THRESHOLD = 80;
const DANGER_THRESHOLD = 95;

type ContextTone = "muted" | "warning" | "danger";

const TONE_TEXT_CLASS: Record<ContextTone, string> = {
  muted: "text-muted-foreground",
  warning: "text-warning",
  danger: "text-destructive",
};

// Cache-stable prefix (prompt + tools) uses the two faintest foreground tints;
// the dynamic parts escalate through primary / info / solid foreground. All
// semantic tokens, so both themes stay in sync.
const PROMPT_SWATCH = "bg-foreground-subtle";
const TOOL_SWATCH = "bg-foreground-ghost";
const SUMMARY_SWATCH = "bg-primary";
const ATTACHMENT_SWATCH = "bg-info";
const CONVERSATION_SWATCH = "bg-foreground";

type ContextPart = {
  id: string;
  tokens: number;
  swatch: string;
  label: string;
  cached: boolean;
};

export const ChatContextMeter = (props: ChatContextMeterProps) => {
  const format = useFormatter();

  if (props.status === "pending") {
    return <ChatContextMeterPending />;
  }

  const { usage } = props;
  if (usage === null) {
    // Zero-state for a brand-new/empty thread: the empty ring in the
    // muted tone, with no popover — there is no conversation to break down
    // yet, so the trigger is inert rather than opening an empty sheet.
    return <EmptyContextMeter />;
  }

  const compact = (value: number) =>
    format.number(value, { notation: "compact", maximumFractionDigits: 1 });

  switch (usage.source) {
    case "harness":
      // Before the harness reports, nothing measures its context: the empty
      // ring, never stella's estimate of a different context.
      return usage.reported === null ? (
        <EmptyContextMeter />
      ) : (
        <ReportedContextMeter compact={compact} reported={usage.reported} />
      );
    case "estimate":
      return <EstimatedContextMeter compact={compact} usage={usage} />;
  }
};

/** The empty ring in the muted tone, with nothing to break down. */
const EmptyContextMeter = () => {
  const t = useTranslations("chat.contextMeter");
  const format = useFormatter();
  return (
    <span
      aria-label={t("triggerLabel", { percent: format.number(0) })}
      className={CHAT_CONTEXT_METER_BOX_CLASS}
      role="status"
    >
      <ContextRing percent={0} />
    </span>
  );
};

/** Stella's estimate of its next send, against the compaction trigger. */
const EstimatedContextMeter = ({
  usage,
  compact,
}: {
  usage: ChatContextEstimate;
  compact: (value: number) => string;
}) => {
  const t = useTranslations("chat.contextMeter");

  const percent = Math.min(
    100,
    Math.round((usage.estimatedTokens / usage.triggerTokens) * 100),
  );
  const parts = buildContextParts({ t, usage });

  return (
    <ContextPopover
      percent={percent}
      source="estimate"
      tokens={t("tokens", {
        used: compact(usage.estimatedTokens),
        total: compact(usage.triggerTokens),
      })}
    >
      <ContextBar parts={parts} usage={usage} />
      <ContextLegend compact={compact} parts={parts} />
      <div className="text-muted-foreground flex flex-col gap-1 text-xs">
        <p>{t("autoCompact")}</p>
        <p>{t("cache")}</p>
      </div>
    </ContextPopover>
  );
};

/**
 * The meter's trigger and sheet: the ring in its tone, then how full the
 * context is and its tokens, then what each meter adds below.
 */
const ContextPopover = ({
  source,
  percent,
  tokens,
  children,
}: {
  /** Whose numbers these are: stella's estimate or the harness's report. */
  source: "estimate" | "reported";
  percent: number;
  tokens: string;
  children: ReactNode;
}) => {
  const t = useTranslations("chat.contextMeter");
  const format = useFormatter();
  const tone = contextTone(percent);
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            aria-label={t("triggerLabel", {
              percent: format.number(percent),
            })}
            className={cn(TONE_TEXT_CLASS[tone])}
            data-source={source}
            size="icon-xs"
            variant="ghost"
          />
        }
      >
        <ContextRing percent={percent} />
      </PopoverTrigger>
      <PopoverPopup
        align="end"
        className="w-[min(24rem,calc(100vw-2rem))]"
        side="top"
      >
        <div className="flex flex-col gap-3">
          <PopoverTitle className="text-sm">{t("title")}</PopoverTitle>
          <div className="flex items-baseline justify-between gap-2">
            <span className={cn("text-sm font-medium", TONE_TEXT_CLASS[tone])}>
              {t("full", { percent: format.number(percent) })}
            </span>
            <span className="text-muted-foreground text-xs tabular-nums">
              {tokens}
            </span>
          </div>
          {children}
        </div>
      </PopoverPopup>
    </Popover>
  );
};

/**
 * The meter for a thread whose turns run on the member's computer: how full
 * the harness said its context was, against its model's window. The harness
 * builds and compacts that context itself, so there is no breakdown.
 */
const ReportedContextMeter = ({
  reported,
  compact,
}: {
  reported: ChatLocalRunContext;
  compact: (value: number) => string;
}) => {
  const t = useTranslations("chat.contextMeter");
  return (
    <ContextPopover
      source="reported"
      percent={Math.min(
        100,
        Math.round((reported.usedTokens / reported.windowTokens) * 100),
      )}
      tokens={t("reportedTokens", {
        used: compact(reported.usedTokens),
        total: compact(reported.windowTokens),
      })}
    >
      <p className="text-muted-foreground text-xs">{t("reported")}</p>
    </ContextPopover>
  );
};

type TranslateFn = ReturnType<typeof useTranslations<"chat.contextMeter">>;

const buildContextParts = ({
  t,
  usage,
}: {
  t: TranslateFn;
  usage: ChatContextEstimate;
}): ContextPart[] => {
  const { breakdown, summarizedMessageCount } = usage;
  const summaryLabel =
    summarizedMessageCount > 0
      ? t("summaryWithCount", {
          count: summarizedMessageCount,
        })
      : t("summary");

  return [
    {
      id: "prompt",
      tokens: breakdown.promptTokens,
      swatch: PROMPT_SWATCH,
      label: t("instructions"),
      cached: true,
    },
    {
      id: "tools",
      tokens: breakdown.toolTokens,
      swatch: TOOL_SWATCH,
      label: t("tools"),
      cached: true,
    },
    {
      id: "summary",
      tokens: breakdown.summaryTokens,
      swatch: SUMMARY_SWATCH,
      label: summaryLabel,
      cached: false,
    },
    {
      id: "attachments",
      tokens: breakdown.attachmentTokens,
      swatch: ATTACHMENT_SWATCH,
      label: t("attachments"),
      cached: false,
    },
    {
      id: "conversation",
      tokens: breakdown.conversationTokens,
      swatch: CONVERSATION_SWATCH,
      label: t("conversation"),
      cached: false,
    },
  ];
};

const contextTone = (percent: number): ContextTone => {
  if (percent >= DANGER_THRESHOLD) {
    return "danger";
  }
  if (percent >= WARNING_THRESHOLD) {
    return "warning";
  }
  return "muted";
};

type ContextBarProps = {
  parts: ContextPart[];
  usage: ChatContextEstimate;
};

const ContextBar = ({ parts, usage }: ContextBarProps) => {
  // Normalize against the larger of the trigger and the estimate so the
  // segments never overflow the track, even once the estimate crosses the
  // trigger (where the ring percent is already clamped to 100).
  const denominator = Math.max(usage.triggerTokens, usage.estimatedTokens);
  const width = (tokens: number) =>
    denominator === 0 ? "0%" : `${(tokens / denominator) * 100}%`;

  return (
    <div
      aria-hidden="true"
      className="bg-muted flex h-1.5 overflow-hidden rounded-full"
    >
      {parts.flatMap((part) =>
        part.tokens > 0
          ? [
              <div
                className={part.swatch}
                key={part.id}
                style={{ width: width(part.tokens) }}
              />,
            ]
          : [],
      )}
    </div>
  );
};

type ContextLegendProps = {
  compact: (value: number) => string;
  parts: ContextPart[];
};

const ContextLegend = ({ compact, parts }: ContextLegendProps) => {
  const t = useTranslations("chat.contextMeter");
  const visibleParts = parts.filter((part) => part.tokens > 0);
  if (visibleParts.length === 0) {
    return null;
  }

  return (
    <ul className="flex flex-col gap-1">
      {visibleParts.map((part) => (
        <li className="flex items-center gap-2 py-0.5 text-xs" key={part.id}>
          <span
            aria-hidden="true"
            className={cn("size-2 shrink-0 rounded-full", part.swatch)}
          />
          <span className="text-foreground">{part.label}</span>
          {part.cached && (
            <span className="bg-muted text-muted-foreground rounded-sm px-1 leading-tight">
              {t("cached")}
            </span>
          )}
          <span className="text-muted-foreground ms-auto tabular-nums">
            {compact(part.tokens)}
          </span>
        </li>
      ))}
    </ul>
  );
};
