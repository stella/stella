import { useFormatter, useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Popover,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "@stll/ui/components/popover";
import { cn } from "@stll/ui/lib/utils";

/** Model-context estimate for a chat thread's next send, as returned by the
 *  chat-messages endpoint. The five breakdown parts sum to `estimatedTokens`,
 *  so the segmented bar renders without any reconciliation. `cacheStableTokens`
 *  (= prompt + tools) is the prompt-cache-stable prefix. */
export type ChatContextUsage = {
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

type ChatContextMeterProps = {
  usage: ChatContextUsage;
};

// Progressive disclosure: the ring is always shown; the percent label appears
// only once the context is half full, and the tone escalates near the trigger.
const PERCENT_LABEL_THRESHOLD = 50;
const WARNING_THRESHOLD = 80;
const DANGER_THRESHOLD = 95;

const RING_RADIUS = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

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

export const ChatContextMeter = ({ usage }: ChatContextMeterProps) => {
  const t = useTranslations("chat.contextMeter");
  const format = useFormatter();

  const percent = Math.min(
    100,
    Math.round((usage.estimatedTokens / usage.triggerTokens) * 100),
  );
  const tone = contextTone(percent);
  const showPercent = percent >= PERCENT_LABEL_THRESHOLD;
  const compact = (value: number) =>
    format.number(value, { notation: "compact", maximumFractionDigits: 1 });

  const parts = buildContextParts({ t, format, usage });

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            aria-label={t("triggerLabel", {
              percent: format.number(percent),
            })}
            className={cn("font-normal", TONE_TEXT_CLASS[tone])}
            size="xs"
            variant="ghost"
          />
        }
      >
        <ContextRing percent={percent} />
        {showPercent && (
          <span className="text-xs">
            {t("percent", { percent: format.number(percent) })}
          </span>
        )}
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-96" side="top">
        <div className="flex flex-col gap-3">
          <PopoverTitle className="text-sm">{t("title")}</PopoverTitle>
          <div className="flex items-baseline justify-between gap-2">
            <span className={cn("text-sm font-medium", TONE_TEXT_CLASS[tone])}>
              {t("full", { percent: format.number(percent) })}
            </span>
            <span className="text-muted-foreground text-xs tabular-nums">
              {t("tokens", {
                used: compact(usage.estimatedTokens),
                total: compact(usage.triggerTokens),
              })}
            </span>
          </div>
          <ContextBar parts={parts} usage={usage} />
          <ContextLegend compact={compact} parts={parts} />
          <div className="text-muted-foreground flex flex-col gap-1 text-xs">
            <p>{t("autoCompact")}</p>
            <p>{t("cache")}</p>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
};

type TranslateFn = ReturnType<typeof useTranslations<"chat.contextMeter">>;
type FormatFn = ReturnType<typeof useFormatter>;

const buildContextParts = ({
  t,
  format,
  usage,
}: {
  t: TranslateFn;
  format: FormatFn;
  usage: ChatContextUsage;
}): ContextPart[] => {
  const { breakdown, summarizedMessageCount } = usage;
  const summaryLabel =
    summarizedMessageCount > 0
      ? t("summaryWithCount", {
          count: format.number(summarizedMessageCount),
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

const ContextRing = ({ percent }: { percent: number }) => {
  const filled = (RING_CIRCUMFERENCE * percent) / 100;

  return (
    <svg
      aria-hidden="true"
      className="size-3.5 -rotate-90"
      fill="none"
      viewBox="0 0 16 16"
    >
      <circle
        className="stroke-current opacity-20"
        cx="8"
        cy="8"
        r={RING_RADIUS}
        strokeWidth="2"
      />
      <circle
        className="stroke-current"
        cx="8"
        cy="8"
        r={RING_RADIUS}
        strokeDasharray={`${filled} ${RING_CIRCUMFERENCE}`}
        strokeLinecap="round"
        strokeWidth="2"
      />
    </svg>
  );
};

type ContextBarProps = {
  parts: ContextPart[];
  usage: ChatContextUsage;
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
      {parts
        .filter((part) => part.tokens > 0)
        .map((part) => (
          <div
            className={part.swatch}
            key={part.id}
            style={{ width: width(part.tokens) }}
          />
        ))}
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
