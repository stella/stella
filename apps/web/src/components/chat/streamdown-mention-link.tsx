import type React from "react";
import { Children } from "react";

import { skipToken, useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  FileTextIcon,
  FolderIcon,
  LandmarkIcon,
  LayersIcon,
  ListTodoIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/lib/utils";

import { openCaseLawDecision } from "@/components/chat/case-law-open";
import type { MentionCategory } from "@/components/chat/chat-mention-href";
import { parseStellaMentionHref } from "@/components/chat/chat-mention-href";
import { openEntityInInspector } from "@/components/chat/entity-open";
import { useExternalSourceStore } from "@/components/chat/external-source-store";
import { navigateToWorkspaceFolder } from "@/components/chat/folder-navigation";
import { InlinePill } from "@/components/inline-pill";
import { PDF_MIME_TYPE } from "@/consts";
import { DOCX_MIME } from "@/lib/consts";
import { FOLIO_SCROLL_EVENT } from "@/lib/folio-scroll-event";
import { getMatterColor } from "@/lib/matter-colors";
import { sanitizeHref } from "@/lib/sanitize-href";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { entityOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";

const DECISION_HASH_PREFIX = "#stella-decision=";
const ENTITY_REF_HASH_PREFIX = "#stella-entity-ref=";
const WORKSPACE_REF_HASH_PREFIX = "#stella-workspace-ref=";
// Hash fragment, NOT a `folio:` scheme. Streamdown runs
// rehype-sanitize over rendered links; only its protocol
// whitelist (http/https/mailto/tel) survives. Custom schemes
// get their href stripped, after which rehype-harden appends
// " [blocked]". Hash-only hrefs are treated as relative and
// pass through untouched, matching how `#stella-entity-ref=`
// and friends already work.
const FOLIO_BLOCK_PREFIX = "#folio:";

const CATEGORY_ICON: Record<
  Exclude<MentionCategory, "entity">,
  React.ComponentType<{ className?: string; style?: React.CSSProperties }>
> = {
  workspace: LayersIcon,
};

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

const ENTITY_EXTENSION_RE = /\.([A-Za-z0-9]{1,8})$/u;
const FOLDER_LABEL_RE = /^(?:folder|složka|priečinok)\b/iu;
const TASK_LABEL_RE = /^(?:task|úkol|úloha)\b/iu;

const getPlainText = (node: React.ReactNode): string | null => {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (!Array.isArray(node)) {
    return null;
  }

  const parts: string[] = [];
  for (const child of Children.toArray(node)) {
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
  const extension = ENTITY_EXTENSION_RE.exec(label.trim())?.at(1);
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

/**
 * Read an entity's first file-field mime type from React Query
 * cache. The mention link already carries the entity ref, so we
 * never need the AI to encode the file extension in the visible
 * label — the right icon comes from the resolved entity itself.
 */
const useResolvedEntityMime = ({
  workspaceId,
  entityId,
}: {
  workspaceId: string | undefined;
  entityId: string | undefined;
}): string | null => {
  // staleTime: Infinity — first render fires one fetch per entity
  // ref; subsequent renders (and the click handler) hit the same
  // cache entry. Keeps mention rendering cheap even with many
  // mentions in a thread.
  const { data } = useQuery({
    ...(workspaceId && entityId
      ? entityOptions(workspaceId, entityId)
      : {
          queryKey: ["mention-entity-disabled"] as const,
          queryFn: skipToken,
        }),
    enabled: workspaceId !== undefined && entityId !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (!data?.fields) {
    return null;
  }
  for (const field of data.fields) {
    if (field.content.type === "file" && field.content.mimeType.length > 0) {
      return field.content.mimeType;
    }
  }
  return null;
};

const EntityChipIcon = ({
  label,
  workspaceId,
  entityId,
}: {
  label: React.ReactNode;
  workspaceId?: string | undefined;
  entityId?: string | undefined;
}) => {
  const resolvedMime = useResolvedEntityMime({ workspaceId, entityId });
  const text = getPlainText(label);

  if (resolvedMime) {
    return <DocumentIcon className="size-3 shrink-0" mimeType={resolvedMime} />;
  }

  if (!text) {
    return <FileTextIcon className="size-3 shrink-0" />;
  }

  if (TASK_LABEL_RE.test(text)) {
    return <ListTodoIcon className="size-3 shrink-0" />;
  }

  if (FOLDER_LABEL_RE.test(text)) {
    return <FolderIcon className="size-3 shrink-0" />;
  }

  const mimeType = getDocumentMimeFromLabel(text);
  if (mimeType) {
    return <DocumentIcon className="size-3 shrink-0" mimeType={mimeType} />;
  }

  return <FileTextIcon className="size-3 shrink-0" />;
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
          ? () => void openCaseLawDecision(decisionRef, navigate)
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
}: {
  rawId: string;
  label: React.ReactNode;
  fallbackWorkspaceId?: string | undefined;
}) => {
  const separator = rawId.indexOf(":");
  const refWorkspaceId =
    separator !== -1 ? rawId.slice(0, separator) : fallbackWorkspaceId;
  const refEntityId = separator !== -1 ? rawId.slice(separator + 1) : rawId;
  return (
    <InlinePill
      leadingIcon={
        <EntityChipIcon
          entityId={refEntityId}
          label={label}
          workspaceId={refWorkspaceId}
        />
      }
      truncate
    >
      {getEntityDisplayLabel(label)}
    </InlinePill>
  );
};

const WorkspaceRefChip = ({ label }: { label: React.ReactNode }) => (
  <InlinePill leadingIcon={<LayersIcon className="size-3 shrink-0" />} truncate>
    {label}
  </InlinePill>
);

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
    void (async () => {
      const result = await openEntityInInspector(id, textLabel, workspaceId);
      if (result.type === "folder") {
        await navigateToWorkspaceFolder({
          folderId: result.entityId,
          navigate,
          pathname,
          targetWorkspaceId: result.workspaceId,
        });
      }
    })();
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

  const { category, id: rawId } = parsed;
  const separator = rawId.indexOf(":");
  const mentionWorkspaceId =
    category === "entity" && separator !== -1
      ? rawId.slice(0, separator)
      : workspaceId;
  const id = separator !== -1 ? rawId.slice(separator + 1) : rawId;
  const textLabel = typeof label === "string" ? label : "Reference";

  if (category === "entity") {
    const icon = (
      <EntityChipIcon
        entityId={id}
        label={label}
        workspaceId={mentionWorkspaceId}
      />
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

  const icon = <CategoryIcon category={category} id={id} />;
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
        void navigate({
          to: "/workspaces/$workspaceId",
          params: { workspaceId: id },
        })
      }
      truncate
    >
      {label}
    </InlinePill>
  );
};

const CategoryIcon = ({
  category,
  id,
}: {
  category: Exclude<MentionCategory, "entity">;
  id: string;
}) => {
  const Icon = CATEGORY_ICON[category];
  return (
    <Icon className="size-3 shrink-0" style={{ color: getMatterColor(id) }} />
  );
};

const MentionChip = ({
  label,
  href,
  interactive,
  workspaceId,
}: MentionChipProps) => {
  if (href.startsWith(DECISION_HASH_PREFIX)) {
    return (
      <DecisionChip
        decisionRef={href.slice(DECISION_HASH_PREFIX.length)}
        interactive={interactive}
        label={label}
      />
    );
  }

  if (href.startsWith(ENTITY_REF_HASH_PREFIX)) {
    return (
      <EntityRefChip
        fallbackWorkspaceId={workspaceId}
        label={label}
        rawId={href.slice(ENTITY_REF_HASH_PREFIX.length)}
      />
    );
  }

  if (href.startsWith(WORKSPACE_REF_HASH_PREFIX)) {
    return <WorkspaceRefChip label={label} />;
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
  if (!href) {
    return <span {...props}>{children}</span>;
  }

  if (href.startsWith(FOLIO_BLOCK_PREFIX)) {
    const blockId = href.slice(FOLIO_BLOCK_PREFIX.length);
    return (
      <FolioBlockChip blockId={blockId} interactive={interactive}>
        {children}
      </FolioBlockChip>
    );
  }

  const mentionChip =
    href.startsWith(DECISION_HASH_PREFIX) ||
    href.startsWith(ENTITY_REF_HASH_PREFIX) ||
    href.startsWith(WORKSPACE_REF_HASH_PREFIX) ||
    parseStellaMentionHref(href) ? (
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
      <a href={href} {...props}>
        {children}
      </a>
    );
  }

  const httpUrl = getHttpUrl(href);
  if (httpUrl) {
    return <FaviconCitationChip children={children} url={httpUrl} />;
  }

  return (
    <a href={href} rel="noopener noreferrer" target="_blank" {...props}>
      {children}
    </a>
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
    const state = useInspectorStore.getState();
    const docxTabId = pickActiveDocxTabId(state);
    if (docxTabId !== null) {
      state.requestBlockScroll(docxTabId, blockId);
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
    // Strip the `b-` prefix and any leading zeros so the fallback
    // reads as a clean ordinal — e.g. `b-0064` → `64` → "str. 64".
    const numeric = blockId.replace(/^b-0*/u, "") || blockId;
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
  return Children.toArray(node)
    .map((child) =>
      typeof child === "string" || typeof child === "number"
        ? String(child)
        : "",
    )
    .join("");
};

const pickActiveDocxTabId = (
  state: ReturnType<typeof useInspectorStore.getState>,
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

const FaviconCitationChip = ({
  children,
  url,
}: {
  children: React.ReactNode;
  url: URL;
}) => {
  const hostname = url.hostname.replace(/^www\./u, "");
  const inlineLabel = getPlainText(children) ?? hostname;
  const source = useExternalSourceStore((state) =>
    state.getSource(url.toString()),
  );
  // Tooltip prefers the registered source title (web_search result
  // title, etc.) over the bare hostname so hover gives the human
  // name of the page, not just the domain.
  const tooltipDetail =
    source?.title && source.title.toLowerCase() !== hostname
      ? `${source.title} — ${hostname}`
      : (inlineLabel !== hostname && `${inlineLabel} — ${hostname}`) ||
        hostname;
  const handleClick = () => {
    useInspectorStore.getState().openExternal({
      url: url.toString(),
      connectorSlug: source?.connectorSlug,
      iconHref: source?.iconHref,
      label: source?.title ?? inlineLabel,
      provider: source?.provider,
      snippet: source?.snippet,
      sourceToolName: source?.sourceToolName,
      text: source?.text,
    });
  };
  return (
    <button
      aria-label={tooltipDetail}
      className={cn(
        "border-border bg-muted/30 hover:bg-muted/60",
        "focus-visible:ring-ring/50",
        "mx-0.5 inline-flex size-[1em] cursor-pointer items-center",
        "justify-center overflow-hidden rounded-full border",
        "align-[-0.2em]",
        "focus-visible:ring-2 focus-visible:outline-none",
      )}
      onClick={handleClick}
      title={tooltipDetail}
      type="button"
    >
      <FaviconImage hostname={hostname} />
    </button>
  );
};

const FaviconImage = ({ hostname }: { hostname: string }) => {
  // Google's public favicon endpoint resolves the actual page icon
  // (handles redirects, missing /favicon.ico, etc.) and serves
  // browser-cached PNGs. Falling back to the source domain's own
  // /favicon.ico would 404 on a lot of legal sites.
  const src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=32`;
  return (
    <img
      alt=""
      aria-hidden="true"
      className="size-[0.85em] object-contain"
      loading="lazy"
      src={src}
    />
  );
};
