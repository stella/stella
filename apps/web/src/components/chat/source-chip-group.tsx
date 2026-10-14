import { useState } from "react";
import type { MouseEventHandler, ReactNode } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { sanitizeHref } from "@stll/decision-reader/sanitize-href";
import { BidiText } from "@stll/ui/bidi-text";
import {
  ChevronDownIcon,
  ExternalLinkIcon,
  LandmarkIcon,
  ScrollTextIcon,
} from "@stll/ui/icons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";
import { cn } from "@stll/ui/utils";

import { openCaseLawDecision } from "@/components/chat/case-law-open";
import { classifyChatHttpLink } from "@/components/chat/chat-app-link.logic";
import type {
  SourceChipGroup,
  SourceChipPart,
  SourceChipPartLabel,
} from "@/components/chat/source-chip-groups.logic";
import { useOpenStatuteLink } from "@/components/chat/statute-open";
import { isPlainPrimaryClick } from "@/components/inspector/case-decision-view";
import { env } from "@/env";
import { useOpenDecisionTab } from "@/features/case-law/open-decision-tab";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";

type OpenAt = (anchorId: string | undefined) => void;

const opener =
  (open: () => void): MouseEventHandler<HTMLAnchorElement> =>
  (event) => {
    if (!isPlainPrimaryClick(event) || event.defaultPrevented) {
      return;
    }
    event.preventDefault();
    open();
  };

/** A reader link as the answer's own links spell it: absolute, on this app. */
const absoluteHref = (href: string): string =>
  URL.canParse(href, env.VITE_PUBLIC_APP_URL)
    ? new URL(href, env.VITE_PUBLIC_APP_URL).href
    : href;

const PartLabel = ({ label }: { label: SourceChipPartLabel }) => {
  const t = useTranslations();
  switch (label.type) {
    case "paragraph":
      return t("caseLaw.citation.paragraphMark", { paragraph: label.number });
    case "text":
      return label.text;
    case "unnamed":
      return t("caseLaw.citation.openAtCitation");
    default:
      label satisfies never;
      return panic(`Unhandled source part label: ${String(label)}`);
  }
};

/**
 * One source of the answer as a single chip: the chip opens the source, a
 * count says how many of its parts the answer drew on, and expanding it
 * lists each part, opening at its block, with the official source last.
 */
const GroupedChip = ({
  href,
  icon,
  label,
  onOpenAt,
  parts,
  sourceUrl,
  title,
}: {
  href: string;
  icon: ReactNode;
  label: string;
  onOpenAt: OpenAt;
  parts: readonly SourceChipPart[];
  sourceUrl: string | undefined;
  title: string | undefined;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const [expanded, setExpanded] = useState(false);
  const toggleLabel = t(expanded ? "common.hideDetails" : "common.showDetails");
  const expandable = parts.length > 0 || sourceUrl !== undefined;
  return (
    <span className="inline-flex max-w-full min-w-0 shrink-0 flex-col items-start gap-1">
      <span className="bg-muted/50 inline-flex max-w-full min-w-0 items-center rounded-md border text-xs">
        <a
          className="hover:bg-muted inline-flex max-w-full min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5"
          href={sanitizeHref(absoluteHref(href))}
          onClick={opener(() => onOpenAt(undefined))}
          title={title}
        >
          {icon}
          <BidiText as="span" className="max-w-[24ch] min-w-0 truncate">
            {label}
          </BidiText>
          {parts.length > 0 && (
            <span
              aria-hidden="true"
              className="text-muted-foreground tabular-nums"
            >
              {format.number(parts.length)}
            </span>
          )}
        </a>
        {expandable && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  aria-expanded={expanded}
                  aria-label={toggleLabel}
                  className="hover:bg-muted text-muted-foreground rounded-md px-1 py-0.5"
                  onClick={() => setExpanded((current) => !current)}
                  type="button"
                />
              }
            >
              <ChevronDownIcon
                aria-hidden="true"
                className={cn(
                  "size-3 transition-transform",
                  expanded && "rotate-180",
                )}
              />
            </TooltipTrigger>
            <TooltipPopup>{toggleLabel}</TooltipPopup>
          </Tooltip>
        )}
      </span>
      {expanded && (
        <ul className="flex flex-col gap-0.5 ps-2 text-xs">
          {parts.map((part) => (
            <li key={part.anchorId}>
              <a
                className="hover:text-foreground text-muted-foreground underline underline-offset-2"
                href={sanitizeHref(absoluteHref(part.url))}
                onClick={opener(() => onOpenAt(part.anchorId))}
              >
                <PartLabel label={part.label} />
              </a>
            </li>
          ))}
          {sourceUrl !== undefined && (
            <li>
              <a
                className="hover:text-foreground text-muted-foreground inline-flex items-center gap-0.5 underline underline-offset-2"
                href={sanitizeHref(sourceUrl)}
                rel="noopener noreferrer"
                target="_blank"
              >
                <ExternalLinkIcon aria-hidden="true" className="size-3" />
                {t("common.openOriginalSource")}
              </a>
            </li>
          )}
        </ul>
      )}
    </span>
  );
};

const DecisionGroupChip = ({
  group,
}: {
  group: Extract<SourceChipGroup, { type: "decision" }>;
}) => {
  const { open } = useOpenDecisionTab();
  const decisionId = group.source.caseLawDecision?.decisionId;
  const title = [group.court, group.decisionDate]
    .filter((part) => part !== null)
    .join(", ");
  return (
    <GroupedChip
      href={group.source.appUrl ?? group.source.url}
      icon={<LandmarkIcon aria-hidden="true" className="size-3 shrink-0" />}
      label={group.label}
      onOpenAt={(anchorId) => {
        if (decisionId === undefined) {
          return;
        }
        detached(
          openCaseLawDecision({ type: "ref", ref: decisionId }, open, {
            anchorId,
          }),
          "source-chips.open-decision",
        );
      }}
      parts={group.parts}
      sourceUrl={group.source.sourceUrl}
      title={title === "" ? undefined : title}
    />
  );
};

const StatuteGroupChip = ({
  group,
}: {
  group: Extract<SourceChipGroup, { type: "statute" }>;
}) => {
  const openStatute = useOpenStatuteLink();
  const appOrigins = new Set([
    new URL(env.VITE_PUBLIC_APP_URL).origin,
    ...(typeof window === "undefined" ? [] : [window.location.origin]),
  ]);
  const openUrl = (url: string) => {
    if (!URL.canParse(url, env.VITE_PUBLIC_APP_URL)) {
      return;
    }
    const link = classifyChatHttpLink(
      new URL(url, env.VITE_PUBLIC_APP_URL),
      appOrigins,
    );
    if (link.type === "statute") {
      detached(openStatute(link.link), "source-chips.open-statute");
    }
  };
  const href = group.source.appUrl ?? group.source.url;
  return (
    <GroupedChip
      href={href}
      icon={<ScrollTextIcon aria-hidden="true" className="size-3 shrink-0" />}
      label={group.label}
      onOpenAt={(anchorId) =>
        openUrl(
          anchorId === undefined
            ? href
            : (group.parts.find((part) => part.anchorId === anchorId)?.url ??
                href),
        )
      }
      parts={group.parts}
      sourceUrl={group.source.sourceUrl}
      title={undefined}
    />
  );
};

/** A decision or an act the answer drew on, as one chip with its parts. */
export const SourceChipGroupChip = ({
  group,
}: {
  group: Extract<SourceChipGroup, { type: "decision" | "statute" }>;
}) =>
  group.type === "decision" ? (
    <DecisionGroupChip group={group} />
  ) : (
    <StatuteGroupChip group={group} />
  );
