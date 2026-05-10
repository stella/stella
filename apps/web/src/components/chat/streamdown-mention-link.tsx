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

const CHIP_CLASS_NAME = cn(
  "inline-flex max-w-56 items-center gap-0.5 align-middle",
  "bg-accent rounded px-1 py-0.5",
  "text-accent-foreground text-xs font-medium",
);

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

const ENTITY_EXTENSION_RE = /\.([A-Za-z0-9]{1,8})$/;
const FOLDER_LABEL_RE = /^(?:folder|složka|priečinok)\b/i;
const TASK_LABEL_RE = /^(?:task|úkol|úloha)\b/i;

const MentionChipLabel = ({ children }: { children: React.ReactNode }) => (
  <span className="min-w-0 truncate">{children}</span>
);

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

const MentionChip = ({
  label,
  href,
  interactive,
  workspaceId,
}: {
  label: React.ReactNode;
  href: string;
  interactive: boolean;
  workspaceId?: string | undefined;
}) => {
  const navigate = useNavigate();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  if (href.startsWith(DECISION_HASH_PREFIX)) {
    const decisionRef = href.slice(DECISION_HASH_PREFIX.length);
    const content = (
      <>
        <LandmarkIcon className="size-3 shrink-0" />
        <MentionChipLabel>{label}</MentionChipLabel>
      </>
    );

    if (!interactive) {
      return <span className={CHIP_CLASS_NAME}>{content}</span>;
    }

    return (
      <button
        className={cn(CHIP_CLASS_NAME, "hover:bg-accent/80 cursor-pointer")}
        onClick={() => void openCaseLawDecision(decisionRef, navigate)}
        type="button"
      >
        {content}
      </button>
    );
  }

  if (
    href.startsWith(ENTITY_REF_HASH_PREFIX) ||
    href.startsWith(WORKSPACE_REF_HASH_PREFIX)
  ) {
    const isEntity = href.startsWith(ENTITY_REF_HASH_PREFIX);
    const rawId = isEntity
      ? href.slice(ENTITY_REF_HASH_PREFIX.length)
      : href.slice(WORKSPACE_REF_HASH_PREFIX.length);
    const separator = rawId.indexOf(":");
    const refWorkspaceId =
      isEntity && separator !== -1 ? rawId.slice(0, separator) : workspaceId;
    const refEntityId = isEntity
      ? separator !== -1
        ? rawId.slice(separator + 1)
        : rawId
      : undefined;
    const icon = isEntity ? (
      <EntityChipIcon
        entityId={refEntityId}
        label={label}
        workspaceId={refWorkspaceId}
      />
    ) : (
      <LayersIcon className="size-3 shrink-0" />
    );
    const displayLabel = isEntity ? getEntityDisplayLabel(label) : label;

    return (
      <span className={CHIP_CLASS_NAME}>
        {icon}
        <MentionChipLabel>{displayLabel}</MentionChipLabel>
      </span>
    );
  }

  const parsed = parseStellaMentionHref(href);
  if (!parsed) {
    return null;
  }

  const { category, id: rawId } = parsed;
  const separator = rawId.indexOf(":");
  const mentionWorkspaceId =
    category === "entity" && separator !== -1
      ? rawId.slice(0, separator)
      : workspaceId;
  const id = separator !== -1 ? rawId.slice(separator + 1) : rawId;
  const textLabel = typeof label === "string" ? label : "Reference";
  const icon =
    category === "entity" ? (
      <EntityChipIcon
        entityId={id}
        label={label}
        workspaceId={mentionWorkspaceId}
      />
    ) : (
      (() => {
        const Icon = CATEGORY_ICON[category];
        return (
          <Icon
            className="size-3 shrink-0"
            {...(category === "workspace"
              ? { style: { color: getMatterColor(id) } }
              : {})}
          />
        );
      })()
    );
  const displayLabel =
    category === "entity" ? getEntityDisplayLabel(label) : label;

  if (!interactive || (category === "entity" && !mentionWorkspaceId)) {
    return (
      <span className={CHIP_CLASS_NAME}>
        {icon}
        <MentionChipLabel>{displayLabel}</MentionChipLabel>
      </span>
    );
  }

  if (category === "entity") {
    return (
      <button
        className={cn(CHIP_CLASS_NAME, "hover:bg-accent/80 cursor-pointer")}
        onClick={() => {
          void (async () => {
            const result = await openEntityInInspector(
              id,
              textLabel,
              mentionWorkspaceId,
            );

            if (result.type === "folder") {
              await navigateToWorkspaceFolder({
                folderId: result.entityId,
                navigate,
                pathname,
                targetWorkspaceId: result.workspaceId,
              });
            }
          })();
        }}
        type="button"
      >
        {icon}
        <MentionChipLabel>{displayLabel}</MentionChipLabel>
      </button>
    );
  }

  return (
    <button
      className={cn(CHIP_CLASS_NAME, "hover:bg-accent/80 cursor-pointer")}
      onClick={() =>
        void navigate({
          to: "/workspaces/$workspaceId",
          params: { workspaceId: id },
        })
      }
      type="button"
    >
      {icon}
      <MentionChipLabel>{displayLabel}</MentionChipLabel>
    </button>
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
    return (
      <button
        className={cn(
          "text-foreground decoration-border underline",
          "underline-offset-2 transition-colors",
          "hover:decoration-foreground cursor-pointer",
        )}
        onClick={() => {
          const source = useExternalSourceStore
            .getState()
            .getSource(httpUrl.toString());
          useInspectorStore.getState().openExternal({
            url: httpUrl.toString(),
            connectorSlug: source?.connectorSlug,
            iconHref: source?.iconHref,
            label: getPlainText(children) ?? source?.title ?? httpUrl.hostname,
            provider: source?.provider,
            snippet: source?.snippet,
            sourceToolName: source?.sourceToolName,
            text: source?.text,
          });
        }}
        type="button"
      >
        {children}
      </button>
    );
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

  if (!interactive) {
    return <span className={CHIP_CLASS_NAME}>{displayedChildren}</span>;
  }

  return (
    <button
      className={cn(
        CHIP_CLASS_NAME,
        "hover:bg-accent/80 cursor-pointer transition-colors",
      )}
      data-block-id={blockId}
      onClick={handleClick}
      type="button"
    >
      <FileTextIcon className="size-3 shrink-0" />
      <MentionChipLabel>{displayedChildren}</MentionChipLabel>
    </button>
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
    const numeric = blockId.replace(/^b-0*/, "") || blockId;
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
