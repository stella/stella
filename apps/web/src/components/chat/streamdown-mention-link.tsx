import type React from "react";
import { Fragment, isValidElement, useState } from "react";

import { useTranslations } from "use-intl";

import {
  parseCanonicalChatSourceCitationHref,
  type ChatSourceCitationTarget,
} from "@stll/api-contract";
import { isCaseLawDecisionId } from "@stll/api-contract/case-law-decision-route";
import { isFolioBlockId } from "@stll/folio-react";
import {
  FileTextIcon,
  FileSpreadsheetIcon,
  GlobeIcon,
  MailIcon,
  PresentationIcon,
} from "@stll/ui/icons";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import {
  ChatDecisionCitation,
  ChatRouteDecisionCitation,
} from "@/components/chat/chat-decision-citation";
import {
  openEmailCitationSource,
  openOfficeCitationSource,
  openSourceBoundEntityFile,
} from "@/components/chat/entity-open";
import { useExternalSourceStore } from "@/components/chat/external-source-store";
import { LegalCitationLink } from "@/components/chat/legal-citation-link";
import { activateSourceCitation } from "@/components/chat/source-citation-navigation";
import { InlinePill } from "@/components/inline-pill";
import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { MarkdownReferenceChip } from "@/components/references/reference-chip";
import {
  isReferenceHref,
  referenceFromHref,
} from "@/components/references/reference.logic";
import { env } from "@/env";
import { useVerifiedEmailCitationTarget } from "@/hooks/use-verified-email-citation-target";
import { useVerifiedOfficeCitationTarget } from "@/hooks/use-verified-office-citation-target";
import { DOCX_MIME } from "@/lib/consts";
import { detached } from "@/lib/detached";
import {
  EMAIL_CITATION_HREF_PREFIX,
  requestEmailCitationScroll,
} from "@/lib/files/email-citations";
import {
  beginOfficeCitationActivation,
  OFFICE_CITATION_HREF_PREFIX,
  requestOfficeCitationNavigation,
} from "@/lib/files/office-citations";
import {
  FOLIO_SCROLL_EVENT,
  type FolioScrollEventDetail,
} from "@/lib/folio-scroll-event";
import { sanitizeHref } from "@/lib/sanitize-href";

// Hash fragment, NOT a `folio:` scheme. Streamdown runs
// rehype-sanitize over rendered links; only its protocol
// whitelist (http/https/mailto/tel) survives. Custom schemes
// get their href stripped, after which rehype-harden appends
// " [blocked]". Hash-only hrefs are treated as relative and
// pass through untouched, matching how `#stella-entity=`
// and friends already work.
const FOLIO_BLOCK_PREFIX = "#folio:";

const isReactNodeArray = (
  node: React.ReactNode,
): node is readonly React.ReactNode[] => Array.isArray(node);

const getPlainText = (node: React.ReactNode): string | null => {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (
    isValidElement<{ children?: React.ReactNode }>(node) &&
    node.type === Fragment
  ) {
    return getPlainText(node.props.children);
  }

  if (!isReactNodeArray(node)) {
    return null;
  }

  const parts: string[] = [];
  for (const child of node) {
    if (child === null || child === undefined || typeof child === "boolean") {
      continue;
    }
    const text = getPlainText(child);
    if (text === null) {
      return null;
    }
    parts.push(text);
  }

  return parts.join("");
};

const getHttpUrl = (href: string): URL | null => {
  const safeHref = sanitizeHref(href);
  if (!safeHref) {
    return null;
  }

  try {
    const url = new URL(safeHref);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
};

type StreamdownMentionLinkProps =
  React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    interactive: boolean;
    workspaceId?: string | undefined;
  };

const ReferenceCitationLink = ({
  href,
  children,
  interactive,
  workspaceId,
}: StreamdownMentionLinkProps & { href: string }) => {
  const parsed = referenceFromHref(href, getPlainText(children) ?? "", {
    renderWorkspaceId: workspaceId,
  });
  const decision =
    parsed?.type === "reference" && parsed.reference.type === "decision"
      ? parsed.reference
      : null;
  const ref = decision?.locator.type === "ref" ? decision.locator.ref : null;
  const source = useExternalSourceStore((state) =>
    ref === null ? undefined : state.getDecisionSource(ref),
  );
  const fallback = (
    <MarkdownReferenceChip
      href={href}
      interactive={interactive}
      workspaceId={workspaceId}
    >
      {children}
    </MarkdownReferenceChip>
  );
  if (
    decision?.locator.type === "ref" &&
    isCaseLawDecisionId(decision.locator.ref)
  ) {
    return (
      <ChatDecisionCitation
        decisionId={decision.locator.ref}
        passage={children}
        anchorId={decision.anchorId ?? undefined}
        interactive={interactive}
      />
    );
  }
  if (decision?.locator.type === "route") {
    return (
      <ChatRouteDecisionCitation
        params={decision.locator.params}
        passage={children}
        anchorId={decision.anchorId ?? undefined}
        interactive={interactive}
      />
    );
  }
  if (source === undefined) {
    return fallback;
  }
  return (
    <LegalCitationLink
      appearance="inline"
      anchorId={decision?.anchorId ?? undefined}
      fallback={fallback}
      interactive={interactive}
      source={source}
      workspaceId={workspaceId}
    >
      {children}
    </LegalCitationLink>
  );
};

export const StreamdownMentionLink = ({
  href,
  children,
  interactive,
  workspaceId,
  ...props
}: StreamdownMentionLinkProps) => {
  const emailCitation = useVerifiedEmailCitationTarget(href ?? "", workspaceId);
  if (!href) {
    return <span {...props}>{children}</span>;
  }

  const sourceCitation = parseCanonicalChatSourceCitationHref(href);
  if (sourceCitation) {
    return (
      <SourceCitationChip interactive={interactive} target={sourceCitation}>
        {children}
      </SourceCitationChip>
    );
  }

  if (href.startsWith(FOLIO_BLOCK_PREFIX)) {
    const rawBlockId = href.slice(FOLIO_BLOCK_PREFIX.length);
    // The AI rendered a `#folio:<id>` href into its answer; refuse
    // anything that doesn't structurally match a folio id so a
    // typo / hallucinated legacy `b-NNNN` doesn't get plumbed
    // through `requestBlockScroll`.
    if (!isFolioBlockId(rawBlockId)) {
      return <span {...props}>{children}</span>;
    }
    return (
      <FolioBlockChip blockId={rawBlockId} interactive={interactive}>
        {children}
      </FolioBlockChip>
    );
  }

  if (href.startsWith(EMAIL_CITATION_HREF_PREFIX)) {
    if (!emailCitation) {
      return <span {...props}>{children}</span>;
    }
    return (
      <EmailCitationChip
        citation={emailCitation}
        interactive={interactive}
        workspaceId={workspaceId}
      >
        {children}
      </EmailCitationChip>
    );
  }

  if (href.startsWith(OFFICE_CITATION_HREF_PREFIX)) {
    return (
      <OfficeCitationLink
        href={href}
        interactive={interactive}
        workspaceId={workspaceId}
      >
        {children}
      </OfficeCitationLink>
    );
  }

  // Entities, matters, decisions, skills and people: the one reference chip.
  if (isReferenceHref(href)) {
    return (
      <ReferenceCitationLink
        href={href}
        interactive={interactive}
        workspaceId={workspaceId}
      >
        {children}
      </ReferenceCitationLink>
    );
  }

  const httpUrl =
    getHttpUrl(href) ??
    (href.startsWith("/")
      ? getHttpUrl(new URL(href, env.VITE_PUBLIC_APP_URL).toString())
      : null);
  if (httpUrl) {
    return (
      <FaviconCitationChip
        href={href}
        interactive={interactive}
        url={httpUrl}
        workspaceId={workspaceId ?? null}
      >
        {children}
      </FaviconCitationChip>
    );
  }

  return (
    <a
      href={sanitizeHref(href)}
      rel="noopener noreferrer"
      target="_blank"
      {...props}
    >
      {children}
    </a>
  );
};

const SourceCitationChip = ({
  children,
  interactive,
  target,
}: {
  children: React.ReactNode;
  interactive: boolean;
  target: ChatSourceCitationTarget;
}) => {
  const visibleText = getPlainText(children)?.trim();
  const fallbackLabel =
    target.type === "pdf-bates" ? target.bates : target.blockId;

  return (
    <InlinePill
      data-block-id={target.type === "docx-folio" ? target.blockId : undefined}
      leadingIcon={<FileTextIcon className="size-3 shrink-0" />}
      onActivate={
        interactive
          ? () => {
              detached(
                activateSourceCitation({
                  target,
                  deps: {
                    openSource: async (source, isCurrent) =>
                      await openSourceBoundEntityFile({
                        entityId: source.entityId,
                        entityVersionId: source.entityVersionId,
                        fieldId: source.fieldId,
                        isCurrent,
                        workspaceId: source.workspaceId,
                      }),
                    requestBlockScroll: (request) => {
                      useInspectorCommandStore
                        .getState()
                        .requestBlockScroll(request);
                    },
                    requestPdfPageScroll: (request) => {
                      useInspectorCommandStore
                        .getState()
                        .requestPdfPageScroll(request);
                    },
                    dispatchBlockScroll: (detail) => {
                      window.dispatchEvent(
                        new CustomEvent<FolioScrollEventDetail>(
                          FOLIO_SCROLL_EVENT,
                          { detail },
                        ),
                      );
                    },
                  },
                }),
                "streamdown-mention-link.open-source-citation",
              );
            }
          : undefined
      }
      truncate
    >
      {visibleText ? children : fallbackLabel}
    </InlinePill>
  );
};

const EmailCitationChip = ({
  citation,
  children,
  interactive,
  workspaceId,
}: {
  citation: NonNullable<ReturnType<typeof useVerifiedEmailCitationTarget>>;
  children: React.ReactNode;
  interactive: boolean;
  workspaceId: string | undefined;
}) => {
  const tCommon = useTranslations("common");
  const { target } = citation;
  const retryLabel = tCommon("retry");
  const handleActivate = (): void => {
    if (citation.type === "error") {
      detached(citation.retry(), "email-citation.retry");
      return;
    }
    if (!workspaceId) {
      return;
    }
    if (citation.type === "unverified") {
      detached(
        (async () => {
          const source = await citation.verify();
          if (!source) {
            return;
          }
          openEmailCitationSource({ source, workspaceId });
          requestEmailCitationScroll(target);
        })(),
        "email-citation.verify",
      );
      return;
    }
    if (citation.type === "verified") {
      openEmailCitationSource({ source: citation.source, workspaceId });
    } else {
      const inspector = useInspectorTabsStore.getState();
      const mountedTab = inspector.tabs.find(
        (tab) =>
          tab.type === "pdf" &&
          tab.id === target.fieldId &&
          tab.entityId === target.entityId,
      );
      if (mountedTab) {
        inspector.setActive(mountedTab.id);
        inspector.setFileFacet(mountedTab.id, "preview");
        inspector.setMinimized(false);
      }
    }
    requestEmailCitationScroll(target);
  };

  return (
    <InlinePill
      {...(citation.type === "error" ? { ariaLabel: retryLabel } : {})}
      {...(citation.type === "error" && interactive
        ? { tooltip: retryLabel }
        : {})}
      data-block-id={target.blockId}
      leadingIcon={<MailIcon className="size-3 shrink-0" />}
      onActivate={
        interactive && (citation.type === "error" || Boolean(workspaceId))
          ? handleActivate
          : undefined
      }
      tone={citation.type === "error" ? "info" : "accent"}
      truncate
    >
      {children}
    </InlinePill>
  );
};

const OfficeCitationChip = ({
  citation,
  children,
  interactive,
  workspaceId,
}: {
  citation: NonNullable<ReturnType<typeof useVerifiedOfficeCitationTarget>>;
  children: React.ReactNode;
  interactive: boolean;
  workspaceId: string | undefined;
}) => {
  const tChat = useTranslations("chat");
  const tCommon = useTranslations("common");
  const { target } = citation;
  const retryLabel = tCommon("retry");
  const handleActivate = (): void => {
    const isCurrentActivation = beginOfficeCitationActivation();
    if (citation.type === "error") {
      detached(citation.retry(), "office-citation.retry");
      return;
    }
    if (!workspaceId) {
      return;
    }
    detached(
      (async () => {
        const verified = await citation.verify();
        if (!isCurrentActivation()) {
          return;
        }
        if (!verified) {
          stellaToast.add({
            title: tChat("officeCitationUnavailable"),
            type: "info",
          });
          return;
        }
        openOfficeCitationSource({
          source: verified.source,
          workspaceId,
        });
        requestOfficeCitationNavigation({
          locator: verified.locator,
          target,
        });
      })(),
      "office-citation.verify",
    );
  };

  return (
    <InlinePill
      {...(citation.type === "error" ? { ariaLabel: retryLabel } : {})}
      {...(citation.type === "error" && interactive
        ? { tooltip: retryLabel }
        : {})}
      data-block-id={target.blockId}
      leadingIcon={
        target.blockId.startsWith("xlsx-") ? (
          <FileSpreadsheetIcon className="size-3 shrink-0" />
        ) : (
          <PresentationIcon className="size-3 shrink-0" />
        )
      }
      onActivate={
        interactive && (citation.type === "error" || Boolean(workspaceId))
          ? handleActivate
          : undefined
      }
      tone={citation.type === "error" ? "info" : "accent"}
      truncate
    >
      {children}
    </InlinePill>
  );
};

const OfficeCitationLink = ({
  children,
  href,
  interactive,
  workspaceId,
}: {
  children: React.ReactNode;
  href: string;
  interactive: boolean;
  workspaceId: string | undefined;
}) => {
  const citation = useVerifiedOfficeCitationTarget(href, workspaceId);
  if (!citation) {
    return <span>{children}</span>;
  }
  return (
    <OfficeCitationChip
      citation={citation}
      interactive={interactive}
      workspaceId={workspaceId}
    >
      {children}
    </OfficeCitationChip>
  );
};

type FolioBlockChipProps = {
  blockId: string;
  interactive: boolean;
  children: React.ReactNode;
};

/**
 * Click-to-scroll chip for an inline `#folio:b-NNNN` citation. The
 * AI emits these in plain answers about an open DOCX. Two delivery
 * paths cover both rendering surfaces:
 *
 *  - **Inspector tab DOCX** — queue a `pendingBlockScroll` in the
 *    inspector store; `PeekDocxViewer` consumes it on its next
 *    effect tick and calls `scrollToBlock` on its editor ref.
 *  - **File-chat-overlay DOCX** — the overlay's editor isn't an
 *    inspector tab, so we ALSO dispatch a window CustomEvent that
 *    any folio editor listens for and reacts to when mounted.
 *
 * Belt-and-braces — whichever surface owns the DOCX picks up the
 * citation; the other ignores it.
 */
const FolioBlockChip = ({
  blockId,
  interactive,
  children,
}: FolioBlockChipProps) => {
  const handleClick = () => {
    const tabsState = useInspectorTabsStore.getState();
    const docxTabId = pickActiveDocxTabId(tabsState);
    if (docxTabId !== null) {
      useInspectorCommandStore
        .getState()
        .requestBlockScroll({ tabId: docxTabId, blockId });
    }
    // Always also broadcast — the overlay editor isn't tracked in
    // the inspector store, so the store path alone is a no-op
    // there.
    window.dispatchEvent(
      new CustomEvent(FOLIO_SCROLL_EVENT, { detail: { blockId } }),
    );
  };

  // Models occasionally emit a degenerate citation where the link
  // text is the bare URL (`[#folio:b-0064](#folio:b-0064)`) or is
  // empty. Surface a clean fallback label so the chip never shows
  // the raw scheme — it's an internal protocol, not user copy.
  const displayedChildren = useFolioChipChildren(children, blockId);

  return (
    <InlinePill
      data-block-id={blockId}
      leadingIcon={<FileTextIcon className="size-3 shrink-0" />}
      onActivate={interactive ? handleClick : undefined}
      truncate
    >
      {displayedChildren}
    </InlinePill>
  );
};

const useFolioChipChildren = (
  children: React.ReactNode,
  blockId: string,
): React.ReactNode => {
  const t = useTranslations();
  const text = collectChipText(children).trim();
  if (text.length === 0 || text.toLowerCase().startsWith("#folio:")) {
    // Strip the `seq-` prefix and any leading zeros so the fallback
    // reads as a clean ordinal — e.g. `seq-0064` → `64` → "str. 64".
    // ParaId-shaped ids surface verbatim.
    const numeric = blockId.replace(/^seq-0*/u, "") || blockId;
    return t("chat.folioCitationFallback", { n: numeric });
  }
  return children;
};

const collectChipText = (node: React.ReactNode): string => {
  if (node === null || node === undefined || node === false) {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(collectChipText).join("");
  }
  if (
    isValidElement<{ children?: React.ReactNode }>(node) &&
    node.type === Fragment
  ) {
    return collectChipText(node.props.children);
  }
  return "";
};

const pickActiveDocxTabId = (
  state: ReturnType<typeof useInspectorTabsStore.getState>,
): string | null => {
  const active = state.tabs.find(
    (tab) =>
      tab.id === state.activeId &&
      tab.type === "pdf" &&
      tab.mimeType === DOCX_MIME,
  );
  if (active) {
    return active.id;
  }
  // Fall back to the first DOCX tab if the chat tab itself is
  // active. Citations should still work when the user is reading
  // chat alongside the document.
  const fallback = state.tabs.find(
    (tab) => tab.type === "pdf" && tab.mimeType === DOCX_MIME,
  );
  return fallback ? fallback.id : null;
};

// A "footnote-style" link label is one whose visible text is short
// and looks like a citation marker — `[1]`, `1`, `(2)`, or the bare
// hostname. Such labels carry no information beyond the chip itself,
// so we render the chip alone. Anything more descriptive (legal
// citations, sentence fragments, human-named sources) is preserved as
// underlined text with the chip appended.
const FOOTNOTE_LABEL_RE = /^[([]?\s*\d{1,3}\s*[)\]]?$/u;
const isFootnoteLabel = (label: string, hostname: string): boolean =>
  FOOTNOTE_LABEL_RE.test(label) || label.toLowerCase() === hostname;

const FaviconCitationChip = ({
  children,
  href,
  interactive,
  url,
  workspaceId,
}: {
  children: React.ReactNode;
  href: string;
  interactive: boolean;
  url: URL;
  workspaceId: string | null;
}) => {
  const hostname = url.hostname.replace(/^www\./u, "");
  const inlineLabel = (getPlainText(children) ?? "").trim();
  const source = useExternalSourceStore(
    (state) => state.getSource(href) ?? state.getSource(url.toString()),
  );
  const showInlineLabel =
    inlineLabel.length > 0 && !isFootnoteLabel(inlineLabel, hostname);
  const hoverTitle = source?.title || inlineLabel || hostname;
  return (
    <LegalCitationLink
      appearance="inline"
      externalIcon={
        <FaviconChip hostname={hostname} inline tooltipTitle={hoverTitle} />
      }
      interactive={interactive}
      source={source ?? { title: hoverTitle, url: url.toString() }}
      workspaceId={workspaceId}
    >
      {showInlineLabel ? children : (source?.title ?? hostname)}
    </LegalCitationLink>
  );
};

const FaviconChip = ({
  hostname,
  onClick,
  inline = false,
  tooltipTitle,
}: {
  hostname: string;
  onClick?: () => void;
  inline?: boolean;
  tooltipTitle: string;
}) => {
  const Wrapper = onClick ? "button" : "span";
  // Defer the favicon GET until the user reveals intent on this
  // specific chip — see <FaviconImage> above for the rationale.
  const [faviconRequested, setFaviconRequested] = useState(false);
  const revealFavicon = () => setFaviconRequested(true);
  return (
    <span
      className={cn(
        "group/citation relative inline-block size-[1em]",
        inline ? "" : "mx-0.5 align-[-0.2em]",
      )}
      onFocus={revealFavicon}
      onMouseEnter={revealFavicon}
    >
      <Wrapper
        aria-label={onClick ? tooltipTitle : undefined}
        className={cn(
          "border-border bg-muted/30",
          "absolute inset-0 grid place-items-center",
          "overflow-hidden rounded-full border",
          onClick
            ? "hover:bg-muted/60 focus-visible:ring-ring/50 cursor-pointer focus-visible:ring-2 focus-visible:outline-none"
            : "",
        )}
        onClick={onClick}
        type={onClick ? "button" : undefined}
      >
        <FaviconImage hostname={hostname} loaded={faviconRequested} />
      </Wrapper>
      <span
        className={cn(
          "border-border bg-popover text-popover-foreground",
          "pointer-events-none absolute start-[calc(100%+0.25em)] top-1/2",
          "z-10 max-w-[20em] -translate-y-1/2 wrap-break-word whitespace-normal",
          "rounded-md border px-1.5 py-0.5 text-[0.78em] leading-none shadow-sm",
          "opacity-0 transition-opacity duration-150",
          "group-focus-within/citation:opacity-100 group-hover/citation:opacity-100",
        )}
        aria-hidden="true"
        role="tooltip"
      >
        {tooltipTitle}
      </span>
    </span>
  );
};

/**
 * Renders the cited domain's favicon ONLY after the parent chip
 * reveals user intent (the `loaded` flag is flipped by the chip
 * wrapper's hover/focus handler). Default render is the bundled
 * GlobeIcon so merely scrolling past a chat message never sends a
 * GET to the cited domain — that passive disclosure is the lever
 * the Codex review flagged.
 */
const FaviconImage = ({
  hostname,
  loaded,
}: {
  hostname: string;
  loaded: boolean;
}) => {
  const [errored, setErrored] = useState(false);
  if (!loaded || errored) {
    return (
      <GlobeIcon
        aria-hidden="true"
        className="text-muted-foreground size-[0.85em]"
      />
    );
  }
  return (
    <img
      alt=""
      aria-hidden="true"
      className="size-[0.85em] object-contain"
      loading="lazy"
      onError={() => setErrored(true)}
      referrerPolicy="no-referrer"
      src={`https://${hostname}/favicon.ico`}
    />
  );
};
