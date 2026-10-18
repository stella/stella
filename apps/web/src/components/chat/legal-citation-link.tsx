import type { MouseEventHandler, ReactElement, ReactNode } from "react";

import { Result, panic } from "better-result";
import { useTranslations } from "use-intl";

import { extractCaseLawDecisionIdFromIdRouteParam } from "@stll/api-contract/case-law-decision-route";
import { resolveLegalCitationLinks } from "@stll/api-contract/legal-citation-links";
import { sanitizeHref } from "@stll/decision-reader/sanitize-href";
import { BidiText } from "@stll/ui/bidi-text";
import { ScrollTextIcon } from "@stll/ui/icons";
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
import type { CitedDecisionParagraph } from "@/components/references/reference.logic";
import { env } from "@/env";
import { ProxyChatLink } from "@/features/chat/components/proxy-chat-link";
import { detached } from "@/lib/detached";

type LegalCitationLinks = ReturnType<typeof resolveLegalCitationLinks>;
type StatuteCitationLinks = Extract<LegalCitationLinks, { type: "statute" }>;

type LegalCitationLinkProps = {
  source: ExternalSourceReference;
  externalHref?: string;
  children: ReactNode;
  interactive: boolean;
  appearance: "inline" | "tray";
  workspaceId?: string | null | undefined;
  anchorId?: string | undefined;
  fallback?: ReactElement;
};

type LegalCitationLabelProps = Pick<
  LegalCitationLinkProps,
  "appearance" | "children"
> & {
  icon: ReactNode;
};

const LegalCitationLabel = ({
  appearance,
  children,
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
  onClick,
}: LegalCitationLinkProps & {
  citation: StatuteCitationLinks;
  onClick?: MouseEventHandler<HTMLAnchorElement> | undefined;
}) => {
  const t = useTranslations();
  const icon = <ScrollTextIcon className="size-3 shrink-0" />;
  const label = (
    <LegalCitationLabel appearance={appearance} icon={icon}>
      {children}
    </LegalCitationLabel>
  );
  return (
    <span className="inline-flex max-w-full shrink-0 items-center gap-1 align-middle">
      <a
        className={cn(
          "cursor-pointer",
          appearance === "tray" &&
            "bg-muted/50 hover:bg-muted inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs",
        )}
        href={sanitizeHref(citation.url)}
        onClick={onClick}
      >
        {label}
      </a>
      {citation.source_url !== undefined && (
        <ProxyChatLink
          href={citation.source_url}
          newTabLabel={t("common.openInNewTab")}
        >
          {t("common.source")}
        </ProxyChatLink>
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

// A publisher alias can carry its paragraph anchor only in the stored reader URL.
const readUrlAnchor = (href: string): string | undefined => {
  const { hash } = new URL(href);
  if (hash === "") {
    return undefined;
  }
  return Result.try(() => decodeURIComponent(hash.slice(1))).unwrapOr(
    undefined,
  );
};

// A source URL's fragment names a block, never the court's number for it:
// only a passage link the server stamped carries that.
const uncountedParagraph = (anchorId: string): CitedDecisionParagraph => ({
  anchorId,
  courtParagraphNumber: null,
});

export const LegalCitationLink = (props: LegalCitationLinkProps) => {
  const t = useTranslations();
  const appOrigins = new Set([
    new URL(env.VITE_PUBLIC_APP_URL).origin,
    ...(typeof window === "undefined" ? [] : [window.location.origin]),
  ]);
  const citation = resolveLegalCitationLinks({
    url: props.source.url,
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
        {...(props.anchorId === undefined
          ? {}
          : { paragraph: uncountedParagraph(props.anchorId) })}
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
      extractCaseLawDecisionIdFromIdRouteParam(citation.params.slug);
    const anchorId = props.anchorId ?? readUrlAnchor(citation.url);
    const decisionProps = {
      passage,
      ...(anchorId === undefined
        ? {}
        : { paragraph: uncountedParagraph(anchorId) }),
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
  switch (citation.type) {
    case "external":
      return (
        <ProxyChatLink
          appearance={props.appearance}
          href={
            citation.url === null ? "" : (props.externalHref ?? citation.url)
          }
          newTabLabel={t("common.openInNewTab")}
        >
          {props.children}
        </ProxyChatLink>
      );
    case "statute":
      return props.interactive ? (
        <InteractiveLegalCitation
          {...props}
          citation={citation}
          appOrigins={appOrigins}
        />
      ) : (
        <LegalCitationView {...props} citation={citation} />
      );
    default:
      citation satisfies never;
      return panic("Unhandled legal citation type");
  }
};
