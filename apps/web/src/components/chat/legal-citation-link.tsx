import type { MouseEventHandler, ReactElement, ReactNode } from "react";

import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import { extractCaseLawDecisionIdFromIdRouteParam } from "@stll/api-contract/case-law-decision-route";
import { resolveLegalCitationLinks } from "@stll/api-contract/legal-citation-links";
import { isPlainPrimaryClick } from "@stll/decision-reader/citation-click";
import { sanitizeHref } from "@stll/decision-reader/sanitize-href";
import { BidiText } from "@stll/ui/bidi-text";
import { cn } from "@stll/ui/utils";

import { openCaseLawDecision } from "@/components/chat/case-law-open";
import { classifyChatHttpLink } from "@/components/chat/chat-app-link.logic";
import { chatAppOrigins } from "@/components/chat/chat-app-origins";
import {
  ChatDecisionCitation,
  ChatRouteDecisionCitation,
} from "@/components/chat/chat-decision-citation";
import type { ExternalSourceReference } from "@/components/chat/external-source-store";
import { useOpenStatuteLink } from "@/components/chat/statute-open";
import { InlinePill } from "@/components/inline-pill";
import type { CitedDecisionParagraph } from "@/components/references/reference.logic";
import { useOpenDecisionTab } from "@/features/case-law/open-decision-tab";
import { ProxyChatLink } from "@/features/chat/components/proxy-chat-link";
import type { LinkIconSource } from "@/features/chat/components/proxy-chat-link";
import { detached } from "@/lib/detached";

type LegalCitationLinks = ReturnType<typeof resolveLegalCitationLinks>;
type StatuteCitationLinks = Extract<LegalCitationLinks, { type: "statute" }>;

type LegalCitationLinkProps = {
  source: ExternalSourceReference;
  /** Whether `source` is a record a tool returned or was built from model text. */
  linkIconSource: LinkIconSource;
  externalHref?: string;
  children: ReactNode;
  interactive: boolean;
  appearance: "inline" | "tray";
  workspaceId?: string | null | undefined;
  anchorId?: string | undefined;
  fallback?: ReactElement;
  fullTrayLabel?: boolean | undefined;
};

// One chip per citation and no glyph: the citation's own text names the
// provision, so the chip only has to read as clickable. The reader opens the
// publisher source, so the chip never trails a second link.
const LegalCitationView = ({
  appearance,
  children,
  citation,
  onClick,
}: LegalCitationLinkProps & {
  citation: StatuteCitationLinks;
  onClick?: MouseEventHandler<HTMLAnchorElement> | undefined;
}) => (
  <a
    className={cn(
      "focus-visible:outline-ring cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2",
      appearance === "tray"
        ? "bg-muted/50 hover:bg-muted inline-flex max-w-full shrink-0 items-center rounded-md border px-1.5 py-0.5 text-xs"
        : "group rounded",
    )}
    href={sanitizeHref(citation.url)}
    onClick={onClick}
  >
    {appearance === "tray" ? (
      <BidiText as="span" className="max-w-[20ch] truncate">
        {children}
      </BidiText>
    ) : (
      <InlinePill className="group-hover:bg-accent/80" truncate>
        {children}
      </InlinePill>
    )}
  </a>
);

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

/** A source-tray row for a decision with a known id: it keeps its full label,
 *  and a plain click opens the decision as an inline citation does, while
 *  other clicks follow the link. */
const DecisionTrayLink = ({
  decisionId,
  href,
  children,
  linkIconSource,
}: {
  decisionId: string;
  href: string;
  children: ReactNode;
  linkIconSource: LinkIconSource;
}) => {
  const t = useTranslations();
  const { open } = useOpenDecisionTab();
  const onClick: MouseEventHandler<HTMLAnchorElement> = (event) => {
    if (!isPlainPrimaryClick(event) || event.defaultPrevented) {
      return;
    }
    event.preventDefault();
    detached(
      openCaseLawDecision({ type: "ref", ref: decisionId }, open),
      "legal-citation.open-tray-decision",
    );
  };
  return (
    <ProxyChatLink
      appearance="tray"
      href={href}
      iconSource={linkIconSource}
      newTabLabel={t("common.openInNewTab")}
      onClick={onClick}
    >
      {children}
    </ProxyChatLink>
  );
};

/** A tray row that shows its own full label: a decision with a known id opens
 *  in the reader, anything else is a link. */
const FullLabelTrayLink = ({
  citation,
  ...props
}: LegalCitationLinkProps & {
  citation: ReturnType<typeof resolveLegalCitationLinks>;
}) => {
  const t = useTranslations();
  const href = citation.type === "external" ? props.source.url : citation.url;
  const decisionId =
    props.source.caseLawDecision?.decisionId ??
    (citation.type === "decision"
      ? extractCaseLawDecisionIdFromIdRouteParam(citation.params.slug)
      : null);
  if (props.interactive && decisionId !== null) {
    return (
      <DecisionTrayLink
        decisionId={decisionId}
        href={href}
        linkIconSource={props.linkIconSource}
      >
        {props.children}
      </DecisionTrayLink>
    );
  }
  return (
    <ProxyChatLink
      appearance="tray"
      href={href}
      iconSource={props.linkIconSource}
      newTabLabel={t("common.openInNewTab")}
    >
      {props.children}
    </ProxyChatLink>
  );
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
  const appOrigins = chatAppOrigins();
  const citation = resolveLegalCitationLinks({
    url: props.source.url,
    sourceUrl: props.source.sourceUrl ?? props.source.url,
    appOrigins,
  });
  if (props.appearance === "tray" && props.fullTrayLabel === true) {
    return <FullLabelTrayLink {...props} citation={citation} />;
  }
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
          iconSource={props.linkIconSource}
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
