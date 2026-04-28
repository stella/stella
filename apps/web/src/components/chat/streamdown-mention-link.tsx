import type React from "react";
import { Children } from "react";

import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  FileTextIcon,
  FolderIcon,
  LandmarkIcon,
  LayersIcon,
  ListTodoIcon,
} from "lucide-react";

import { cn } from "@stella/ui/lib/utils";

import { openCaseLawDecision } from "@/components/chat/case-law-open";
import type { MentionCategory } from "@/components/chat/chat-mention-href";
import { parseStellaMentionHref } from "@/components/chat/chat-mention-href";
import { openEntityInInspector } from "@/components/chat/entity-open";
import { navigateToWorkspaceFolder } from "@/components/chat/folder-navigation";
import { PDF_MIME_TYPE } from "@/consts";
import { DOCX_MIME } from "@/lib/consts";
import { getMatterColor } from "@/lib/matter-colors";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";

const DECISION_HASH_PREFIX = "#stella-decision=";
const ENTITY_REF_HASH_PREFIX = "#stella-entity-ref=";
const WORKSPACE_REF_HASH_PREFIX = "#stella-workspace-ref=";

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

const EntityChipIcon = ({ label }: { label: React.ReactNode }) => {
  const text = getPlainText(label);
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
    const icon = isEntity ? (
      <EntityChipIcon label={label} />
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
      <EntityChipIcon label={label} />
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

  return (
    <a href={href} rel="noopener noreferrer" target="_blank" {...props}>
      {children}
    </a>
  );
};
