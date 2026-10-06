import type {
  FocusEventHandler,
  MouseEventHandler,
  ReactElement,
  ReactNode,
} from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { extractCaseLawDecisionIdFromIdRouteParam } from "@stll/api-contract/case-law-decision-route";
import { resolveLegalCitationLinks } from "@stll/api-contract/legal-citation-links";
import { BidiText } from "@stll/ui/bidi-text";
import { ExternalLinkIcon, ScrollTextIcon } from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

import { classifyChatHttpLink } from "@/components/chat/chat-app-link.logic";
import {
  ChatDecisionCitation,
  ChatRouteDecisionCitation,
} from "@/components/chat/chat-decision-citation";
import type { ExternalSourceReference } from "@/components/chat/external-source-store";
import { useOpenStatuteLink } from "@/components/chat/statute-open";
import { InlinePill } from "@/components/inline-pill";
import { isPlainPrimaryClick } from "@/components/inspector/case-decision-view";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { env } from "@/env";
import { detached } from "@/lib/detached";
import { sanitizeHref } from "@/lib/sanitize-href";

type LegalCitationLinks = ReturnType<typeof resolveLegalCitationLinks>;
type DisplayedLegalCitationLinks = Exclude<
  LegalCitationLinks,
  { type: "decision" }
>;
type StatuteCitationLinks = Extract<LegalCitationLinks, { type: "statute" }>;

type LegalCitationLinkProps = {
  source: ExternalSourceReference;
  children: ReactNode;
  interactive: boolean;
  appearance: "inline" | "tray";
  workspaceId?: string | null | undefined;
  externalIcon?: ReactElement;
  anchorId?: string | undefined;
  fallback?: ReactElement;
  onFocus?: FocusEventHandler<HTMLAnchorElement>;
  onMouseEnter?: MouseEventHandler<HTMLAnchorElement>;
};

const legalCitationIcon = (
  citation: DisplayedLegalCitationLinks,
  externalIcon: ReactElement | undefined,
) => {
  switch (citation.type) {
    case "statute":
      return <ScrollTextIcon className="size-3 shrink-0" />;
    case "external":
      return externalIcon ?? <ExternalLinkIcon className="size-3 shrink-0" />;
    default:
      citation satisfies never;
      return panic(`Unhandled legal citation: ${String(citation)}`);
  }
};

type LegalCitationLabelProps = Pick<
  LegalCitationLinkProps,
  "appearance" | "children"
> & {
  citation: DisplayedLegalCitationLinks;
  icon: ReactNode;
};

const LegalCitationLabel = ({
  appearance,
  children,
  citation,
  icon,
}: LegalCitationLabelProps) => {
  if (appearance === "tray") {
    return (
      <>
        <span>{icon}</span>
        <BidiText as="span" className="max-w-[20ch] truncate">
          {children}
        </BidiText>
      </>
    );
  }
  if (citation.type === "external") {
    return (
      <span className="inline-flex items-center gap-1">
        {children}
        {icon}
      </span>
    );
  }
  return (
    <InlinePill leadingIcon={icon} truncate>
      {children}
    </InlinePill>
  );
};

const LegalCitationView = ({
  appearance,
  children,
  citation,
  externalIcon,
  onClick,
  onFocus,
  onMouseEnter,
}: LegalCitationLinkProps & {
  citation: DisplayedLegalCitationLinks;
  onClick?: MouseEventHandler<HTMLAnchorElement> | undefined;
}) => {
  const t = useTranslations();
  const icon = legalCitationIcon(citation, externalIcon);
  const label = (
    <LegalCitationLabel appearance={appearance} citation={citation} icon={icon}>
      {children}
    </LegalCitationLabel>
  );
  if (citation.url === null) {
    return <span>{label}</span>;
  }
  return (
    <span className="inline-flex max-w-full shrink-0 items-center gap-1 align-middle">
      <a
        className={cn(
          "cursor-pointer",
          appearance === "inline" &&
            citation.type === "external" &&
            "text-foreground decoration-border hover:decoration-foreground underline underline-offset-2",
          appearance === "tray" &&
            "bg-muted/50 hover:bg-muted inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs",
        )}
        href={sanitizeHref(citation.url)}
        onClick={onClick}
        onFocus={onFocus}
        onMouseEnter={onMouseEnter}
        {...(citation.type === "external"
          ? { target: "_blank", rel: "noopener noreferrer" }
          : {})}
      >
        {label}
      </a>
      {citation.type !== "external" && citation.source_url !== undefined && (
        <a
          className="text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center gap-0.5 text-xs underline underline-offset-2"
          href={sanitizeHref(citation.source_url)}
          rel="noopener noreferrer"
          target="_blank"
        >
          <ExternalLinkIcon aria-hidden="true" className="size-3" />
          {t("common.source")}
        </a>
      )}
    </span>
  );
};

const InteractiveLegalCitation = ({
  citation,
  appOrigins,
  ...props
}: LegalCitationLinkProps & {
  citation: StatuteCitationLinks;
  appOrigins: ReadonlySet<string>;
}) => {
  const openStatute = useOpenStatuteLink();
  const onClick: MouseEventHandler<HTMLAnchorElement> = (event) => {
    if (!isPlainPrimaryClick(event) || event.defaultPrevented) {
      return undefined;
    }
    event.preventDefault();
    const url = new URL(citation.url);
    const link = classifyChatHttpLink(url, appOrigins);
    switch (link.type) {
      case "statute":
        detached(openStatute(link.link), "legal-citation.open-statute");
        return undefined;
      case "decision":
        return panic("A statute citation must resolve to a statute route");
      case "external":
        return panic(
          "Resolved legal citation must name an internal legal route",
        );
      default:
        link satisfies never;
        return panic(`Unhandled legal citation: ${String(link)}`);
    }
  };
  return <LegalCitationView {...props} citation={citation} onClick={onClick} />;
};

export const LegalCitationLink = (props: LegalCitationLinkProps) => {
  const appOrigins = new Set([
    new URL(env.VITE_PUBLIC_APP_URL).origin,
    ...(typeof window === "undefined" ? [] : [window.location.origin]),
  ]);
  const citation = resolveLegalCitationLinks({
    appUrl: props.source.appUrl ?? props.source.url,
    sourceUrl: props.source.sourceUrl ?? props.source.url,
    appOrigins,
  });
  const passage =
    props.appearance === "inline"
      ? props.children
      : (props.source.snippet ?? props.source.text ?? props.children);
  if (
    citation.type === "external" &&
    props.source.caseLawDecision !== undefined
  ) {
    return (
      <ChatDecisionCitation
        decisionId={props.source.caseLawDecision.decisionId}
        passage={passage}
        anchorId={props.anchorId}
        {...(citation.url === null ? {} : { originalUrl: citation.url })}
        interactive={props.interactive}
        renderPassage={props.appearance === "inline"}
      />
    );
  }
  if (
    citation.type === "external" &&
    citation.url === null &&
    props.fallback !== undefined
  ) {
    return props.fallback;
  }
  if (citation.type === "decision" && props.anchorId !== undefined) {
    const url = new URL(citation.url);
    url.hash = props.anchorId;
    citation.url = url.href;
  }
  if (citation.type === "decision") {
    const decisionId =
      props.source.caseLawDecision?.decisionId ??
      extractCaseLawDecisionIdFromIdRouteParam(citation.params.caseNumber);
    const decisionProps = {
      passage,
      anchorId: props.anchorId,
      readerUrl: citation.url,
      ...(citation.source_url === undefined
        ? {}
        : { originalUrl: citation.source_url }),
      interactive: props.interactive,
      renderPassage: props.appearance === "inline",
    };
    return decisionId === null ? (
      <ChatRouteDecisionCitation {...decisionProps} params={citation.params} />
    ) : (
      <ChatDecisionCitation {...decisionProps} decisionId={decisionId} />
    );
  }
  if (citation.type !== "external" && props.interactive) {
    return (
      <InteractiveLegalCitation
        {...props}
        citation={citation}
        appOrigins={appOrigins}
      />
    );
  }
  const externalUrl = citation.url;
  const onClick: MouseEventHandler<HTMLAnchorElement> | undefined =
    props.interactive && citation.type === "external" && externalUrl !== null
      ? (event) => {
          if (!isPlainPrimaryClick(event) || event.defaultPrevented) {
            return;
          }
          event.preventDefault();
          useInspectorTabsStore.getState().openExternal({
            ...props.source,
            url: externalUrl,
            label: props.source.title,
            workspaceId: props.workspaceId ?? null,
          });
        }
      : undefined;
  return <LegalCitationView {...props} citation={citation} onClick={onClick} />;
};
