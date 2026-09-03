import type React from "react";
import { Fragment, isValidElement, useState } from "react";

import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  FileTextIcon,
  FileSpreadsheetIcon,
  GlobeIcon,
  LandmarkIcon,
  MailIcon,
  PresentationIcon,
  WandSparklesIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import {
  parseCanonicalChatSourceCitationHref,
  parseChatResourceHref,
  RESOURCE_TYPE,
  type ChatSourceCitationTarget,
} from "@stll/api-contract";
import { isFolioBlockId } from "@stll/folio-react";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import { openCaseLawDecision } from "@/components/chat/case-law-open";
import {
  parseStellaMentionHref,
  resolveMentionWorkspaceId,
} from "@/components/chat/chat-mention-href";
import { useEntityIconSource } from "@/components/chat/entity-icon-source";
import {
  openEmailCitationSource,
  openEntityInInspector,
  openOfficeCitationSource,
  openSourceBoundEntityFile,
} from "@/components/chat/entity-open";
import { useExternalSourceStore } from "@/components/chat/external-source-store";
import { navigateToWorkspaceFolder } from "@/components/chat/folder-navigation";
import { activateSourceCitation } from "@/components/chat/source-citation-navigation";
import { InlinePill } from "@/components/inline-pill";
import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { MatterIcon } from "@/components/matter-icon";
import { EntityIcon } from "@/components/workspaces/entity-kind-icon";
import { PDF_MIME_TYPE } from "@/consts";
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

const ENTITY_REF_HASH_PREFIX = "#stella-entity-ref=";
const WORKSPACE_REF_HASH_PREFIX = "#stella-workspace-ref=";
/**
 * The server rewrites a citation whose ref was never minted this turn to
 * this href (see `CHAT_UNRESOLVED_REF_HREF` in the API's ref registry): a
 * fabricated or mangled mention must render as plain text, never as a
 * clickable pill that looks like a real document.
 */
const UNRESOLVED_REF_HREF = "#stella-unresolved-ref";
const UUID_SHAPE_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export const SKILL_REF_HASH_PREFIX = "#stella-skill-ref=";
// Hash fragment, NOT a `folio:` scheme. Streamdown runs
// rehype-sanitize over rendered links; only its protocol
// whitelist (http/https/mailto/tel) survives. Custom schemes
// get their href stripped, after which rehype-harden appends
// " [blocked]". Hash-only hrefs are treated as relative and
// pass through untouched, matching how `#stella-entity-ref=`
// and friends already work.
const FOLIO_BLOCK_PREFIX = "#folio:";

const DOCUMENT_MIME_BY_EXTENSION: Record<string, string> = {
  csv: "text/csv",
  doc: "application/msword",
  docx: DOCX_MIME,
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  odt: "application/vnd.oasis.opendocument.text",
  pdf: PDF_MIME_TYPE,
  png: "image/png",
  rtf: "application/rtf",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const ENTITY_EXTENSION_RE = /\.(?<ext>[A-Za-z0-9]{1,8})$/u;
const SKILL_CHIP_ICON = <WandSparklesIcon className="size-3 shrink-0" />;

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

const getDocumentMimeFromLabel = (label: string): string | null => {
  const extension = ENTITY_EXTENSION_RE.exec(label.trim())?.groups?.["ext"];
  if (!extension) {
    return null;
  }

  return DOCUMENT_MIME_BY_EXTENSION[extension.toLowerCase()] ?? null;
};

const stripDocumentExtension = (label: string) => {
  if (!getDocumentMimeFromLabel(label)) {
    return label;
  }

  return label.trim().replace(ENTITY_EXTENSION_RE, "");
};

const getEntityDisplayLabel = (label: React.ReactNode): React.ReactNode => {
  const text = getPlainText(label);
  if (!text) {
    return label;
  }

  return stripDocumentExtension(text);
};

const EntityChipIcon = ({
  workspaceId,
  entityId,
}: {
  workspaceId?: string | undefined;
  entityId?: string | undefined;
}) => {
  const source = useEntityIconSource({ entityId, workspaceId });
  return <EntityIcon className="size-3 shrink-0" source={source} />;
};

type MentionChipProps = {
  label: React.ReactNode;
  href: string;
  interactive: boolean;
  workspaceId?: string | undefined;
};

const DecisionChip = ({
  decisionRef,
  label,
  interactive,
}: {
  decisionRef: string;
  label: React.ReactNode;
  interactive: boolean;
}) => {
  const navigate = useNavigate();
  return (
    <InlinePill
      leadingIcon={<LandmarkIcon className="size-3 shrink-0" />}
      onActivate={
        interactive
          ? () =>
              detached(
                openCaseLawDecision(decisionRef, navigate),
                "streamdown-mention-link.open-case-law-decision",
              )
          : undefined
      }
      truncate
    >
      {label}
    </InlinePill>
  );
};

const EntityRefChip = ({
  rawId,
  label,
  fallbackWorkspaceId,
  interactive,
}: {
  rawId: string;
  label: React.ReactNode;
  fallbackWorkspaceId?: string | undefined;
  interactive: boolean;
}) => {
  const navigate = useNavigate();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  const separator = rawId.indexOf(":");
  const refWorkspaceId =
    separator !== -1 ? rawId.slice(0, separator) : fallbackWorkspaceId;
  const refEntityId = separator !== -1 ? rawId.slice(separator + 1) : rawId;
  const textLabel = typeof label === "string" ? label : "Reference";
  // Legacy persisted text may carry an unresolved per-turn ref (`ent_99`)
  // where a stable entity UUID belongs; before this guard it fell back to
  // the current workspace and rendered as a real-looking, broken pill.
  if (!UUID_SHAPE_REGEX.test(refEntityId)) {
    return <span>{label}</span>;
  }
  const icon = (
    <EntityChipIcon entityId={refEntityId} workspaceId={refWorkspaceId} />
  );
  const displayLabel = getEntityDisplayLabel(label);

  if (!interactive || !refWorkspaceId) {
    return (
      <InlinePill leadingIcon={icon} truncate>
        {displayLabel}
      </InlinePill>
    );
  }

  return (
    <InlinePill
      leadingIcon={icon}
      onActivate={buildParsedEntityActivate({
        navigate,
        pathname,
        id: refEntityId,
        textLabel,
        workspaceId: refWorkspaceId,
      })}
      truncate
    >
      {displayLabel}
    </InlinePill>
  );
};

const SkillRefChip = ({
  label,
  interactive,
}: {
  slug: string;
  label: React.ReactNode;
  interactive: boolean;
}) => {
  const navigate = useNavigate();
  if (!interactive) {
    return (
      <InlinePill leadingIcon={SKILL_CHIP_ICON} truncate>
        {label}
      </InlinePill>
    );
  }
  return (
    <InlinePill
      leadingIcon={SKILL_CHIP_ICON}
      onActivate={() =>
        detached(
          navigate({ to: "/knowledge/tools", search: { kind: "skill" } }),
          "streamdown-mention-link.navigate",
        )
      }
      truncate
    >
      {label}
    </InlinePill>
  );
};

const WorkspaceRefChip = ({
  workspaceId,
  label,
  interactive,
}: {
  workspaceId: string;
  label: React.ReactNode;
  interactive: boolean;
}) => {
  const navigate = useNavigate();
  // Same guard as EntityRefChip: an unresolved `mat_99` in legacy persisted
  // text must not render as a navigable matter pill.
  if (!UUID_SHAPE_REGEX.test(workspaceId)) {
    return <span>{label}</span>;
  }
  const icon = (
    <MatterIcon
      className="size-3 shrink-0"
      matter={{ id: workspaceId, color: null }}
    />
  );
  if (!interactive) {
    return (
      <InlinePill leadingIcon={icon} truncate>
        {label}
      </InlinePill>
    );
  }
  return (
    <InlinePill
      leadingIcon={icon}
      onActivate={() =>
        detached(
          navigate({
            to: "/workspaces/$workspaceId",
            params: { workspaceId },
          }),
          "streamdown-mention-link.navigate",
        )
      }
      truncate
    >
      {label}
    </InlinePill>
  );
};

const buildParsedEntityActivate =
  ({
    navigate,
    pathname,
    id,
    textLabel,
    workspaceId,
  }: {
    navigate: ReturnType<typeof useNavigate>;
    pathname: string;
    id: string;
    textLabel: string;
    workspaceId: string;
  }) =>
  () => {
    detached(
      (async () => {
        const result = await openEntityInInspector(id, textLabel, workspaceId);
        if (result.type === "folder") {
          await navigateToWorkspaceFolder({
            folderId: result.entityId,
            navigate,
            pathname,
            targetWorkspaceId: result.workspaceId,
          });
        }
      })(),
      "streamdown-mention-link.open-entity-in-inspector",
    );
  };

const ParsedMentionChip = ({
  parsed,
  label,
  interactive,
  workspaceId,
}: {
  parsed: NonNullable<ReturnType<typeof parseStellaMentionHref>>;
  label: React.ReactNode;
  interactive: boolean;
  workspaceId?: string | undefined;
}) => {
  const navigate = useNavigate();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  const { category, target } = parsed;
  const mentionWorkspaceId = resolveMentionWorkspaceId(target, workspaceId);
  const id = target.resource.id;
  const textLabel = typeof label === "string" ? label : "Reference";

  if (category === "entity") {
    const icon = (
      <EntityChipIcon entityId={id} workspaceId={mentionWorkspaceId} />
    );
    const displayLabel = getEntityDisplayLabel(label);
    if (!interactive || !mentionWorkspaceId) {
      return (
        <InlinePill leadingIcon={icon} truncate>
          {displayLabel}
        </InlinePill>
      );
    }
    return (
      <InlinePill
        leadingIcon={icon}
        onActivate={buildParsedEntityActivate({
          navigate,
          pathname,
          id,
          textLabel,
          workspaceId: mentionWorkspaceId,
        })}
        truncate
      >
        {displayLabel}
      </InlinePill>
    );
  }

  const icon = <CategoryIcon id={id} />;
  if (!interactive) {
    return (
      <InlinePill leadingIcon={icon} truncate>
        {label}
      </InlinePill>
    );
  }
  return (
    <InlinePill
      leadingIcon={icon}
      onActivate={() =>
        detached(
          navigate({
            to: "/workspaces/$workspaceId",
            params: { workspaceId: id },
          }),
          "streamdown-mention-link.navigate",
        )
      }
      truncate
    >
      {label}
    </InlinePill>
  );
};

const CategoryIcon = ({ id }: { id: string }) => (
  <MatterIcon className="size-3 shrink-0" matter={{ id, color: null }} />
);

const MentionChip = ({
  label,
  href,
  interactive,
  workspaceId,
}: MentionChipProps) => {
  const resourceTarget = parseChatResourceHref(href);
  if (resourceTarget?.resource.type === RESOURCE_TYPE.CASE_LAW_DECISION) {
    return (
      <DecisionChip
        decisionRef={resourceTarget.resource.id}
        interactive={interactive}
        label={label}
      />
    );
  }

  if (href.startsWith(ENTITY_REF_HASH_PREFIX)) {
    return (
      <EntityRefChip
        fallbackWorkspaceId={workspaceId}
        interactive={interactive}
        label={label}
        rawId={href.slice(ENTITY_REF_HASH_PREFIX.length)}
      />
    );
  }

  if (href.startsWith(WORKSPACE_REF_HASH_PREFIX)) {
    return (
      <WorkspaceRefChip
        interactive={interactive}
        label={label}
        workspaceId={href.slice(WORKSPACE_REF_HASH_PREFIX.length)}
      />
    );
  }

  if (href.startsWith(SKILL_REF_HASH_PREFIX)) {
    return (
      <SkillRefChip
        interactive={interactive}
        label={label}
        slug={href.slice(SKILL_REF_HASH_PREFIX.length)}
      />
    );
  }

  const parsed = parseStellaMentionHref(href);
  if (!parsed) {
    return null;
  }

  return (
    <ParsedMentionChip
      interactive={interactive}
      label={label}
      parsed={parsed}
      workspaceId={workspaceId}
    />
  );
};

type StreamdownMentionLinkProps =
  React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    interactive: boolean;
    workspaceId?: string | undefined;
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

  if (href === UNRESOLVED_REF_HREF) {
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

  const mentionChip =
    parseChatResourceHref(href) !== null ||
    href.startsWith(ENTITY_REF_HASH_PREFIX) ||
    href.startsWith(WORKSPACE_REF_HASH_PREFIX) ||
    href.startsWith(SKILL_REF_HASH_PREFIX) ? (
      <MentionChip
        href={href}
        interactive={interactive}
        label={children}
        workspaceId={workspaceId}
      />
    ) : null;

  if (mentionChip) {
    return mentionChip;
  }

  if (!interactive) {
    return (
      <a href={sanitizeHref(href)} {...props}>
        {children}
      </a>
    );
  }

  const httpUrl = getHttpUrl(href);
  if (httpUrl) {
    return (
      <FaviconCitationChip
        children={children}
        url={httpUrl}
        workspaceId={workspaceId ?? null}
      />
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
  url,
  workspaceId,
}: {
  children: React.ReactNode;
  url: URL;
  workspaceId: string | null;
}) => {
  const hostname = url.hostname.replace(/^www\./u, "");
  const inlineLabel = (getPlainText(children) ?? "").trim();
  const source = useExternalSourceStore((state) =>
    state.getSource(url.toString()),
  );
  const hoverTitle = source?.title || inlineLabel || hostname;
  const showInlineLabel =
    inlineLabel.length > 0 && !isFootnoteLabel(inlineLabel, hostname);
  const handleClick = () => {
    useInspectorTabsStore.getState().openExternal({
      url: url.toString(),
      connectorSlug: source?.connectorSlug,
      iconHref: source?.iconHref,
      label: source?.title ?? inlineLabel,
      provider: source?.provider,
      snippet: source?.snippet,
      sourceToolName: source?.sourceToolName,
      text: source?.text,
      workspaceId,
    });
  };

  if (showInlineLabel) {
    return (
      <button
        aria-label={`${hoverTitle} (${hostname})`}
        className={cn(
          "text-foreground decoration-border underline",
          "underline-offset-2 transition-colors",
          "hover:decoration-foreground cursor-pointer",
          "inline-flex items-center gap-1",
        )}
        onClick={handleClick}
        type="button"
      >
        <span>{children}</span>
        <FaviconChip hostname={hostname} inline tooltipTitle={hoverTitle} />
      </button>
    );
  }

  return (
    <FaviconChip
      hostname={hostname}
      onClick={handleClick}
      tooltipTitle={hoverTitle}
    />
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
