import { useRef, useState } from "react";

import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/components/bidi-text";
import {
  PreviewCard,
  PreviewCardPopup,
  PreviewCardTrigger,
} from "@stll/ui/components/preview-card";
import { cn } from "@stll/ui/lib/utils";

import { UserAvatar } from "@/components/user-avatar";
import { formatRelativeTime } from "@/lib/relative-time";
import type {
  FieldId,
  JustificationContent,
  WorkspaceCellMetadata,
  WorkspaceEntity,
  WorkspaceField,
  WorkspaceJustification,
} from "@/lib/types";
import {
  getCellFlagById,
  useFlagLabel,
} from "@/routes/_protected.workspaces/$workspaceId/-components/cell-metadata-flags";
import { EntityKindIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/entity-kind-icon";
import { getFirstFile } from "@/routes/_protected.workspaces/$workspaceId/-utils";

type AICellSourceCardProps = React.PropsWithChildren<{
  entity: WorkspaceEntity;
  justification: WorkspaceJustification;
  cellMetadata: WorkspaceCellMetadata | undefined;
  /**
   * Opens the cited document with this justification highlighted. Omitted for
   * verdict cells, whose provenance is the rationale itself with no document to
   * open; the card then renders as a static (non-clickable) popover.
   */
  onOpen?: () => void;
  /**
   * Overrides the trigger wrapper sizing. Defaults to filling the cell
   * (`w-full min-w-0`); a verdict dot beside an ASK value passes `shrink-0` so
   * the card hugs the dot instead of stretching across the merged cell.
   */
  triggerClassName?: string;
  /**
   * Optional heading rendered above the statements. The verdict dot passes the
   * tier label here so the always-on text label can be dropped from the cell
   * without losing it from the provenance card.
   */
  title?: string;
  /**
   * Clamp each statement to three lines (default). The verdict card passes
   * false so the full grading rationale (up to ~1000 chars) is readable; it
   * scrolls inside the popup instead of being truncated. Document-citation
   * cells keep clamping so a long extraction can't push the evidence away.
   */
  clampStatements?: boolean;
}>;

/**
 * Hover provenance for AI-filled cells: the source document and the
 * extraction statements with their citations, so the value can be
 * verified without opening the file. Clicking the card opens the
 * document preview at the justification, same as the cell's inline
 * Preview action.
 */
export const AICellSourceCard = ({
  entity,
  justification,
  cellMetadata,
  onOpen,
  triggerClassName,
  title,
  clampStatements = true,
  children,
}: AICellSourceCardProps) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  // The card is a hover preview: a click on the cell (to edit it) should dismiss
  // it and keep it dismissed until the pointer leaves; re-hovering reopens it.
  const dismissedRef = useRef(false);
  const handleOpenChange = (next: boolean) => {
    if (next && dismissedRef.current) {
      return;
    }
    setOpen(next);
  };
  const flags = cellMetadata ? cellMetadata.manualFlags : [];
  const sourceFiles = resolveSourceFiles(entity, justification);
  const primaryFile = sourceFiles.at(0);
  // The row's document column already names the entity's first file;
  // repeat the source only when the citation points elsewhere.
  const showSourceFile =
    sourceFiles.length > 1 ||
    (primaryFile !== undefined &&
      primaryFile.fieldId !== getFirstFile(entity)?.fieldId);
  const statements = flattenStatements(justification.content);
  const visibleStatements = statements.slice(0, MAX_STATEMENTS);
  const hiddenStatementCount = statements.length - visibleStatements.length;
  const statementTextClassName = cn(
    "text-justify text-xs leading-relaxed text-wrap hyphens-auto",
    // Unclamped rationale scrolls within the popup rather than truncating; the
    // container must be block-level for max-height/overflow to form a scroll box
    // (an inline span ignores both).
    clampStatements ? "line-clamp-3" : "block max-h-64 overflow-y-auto",
  );

  const cardContent = (
    <>
      {title !== undefined && (
        <span className="text-foreground-strong text-xs font-semibold">
          {title}
        </span>
      )}
      {showSourceFile && primaryFile && (
        <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
          <EntityKindIcon
            className="size-3.5 shrink-0"
            fileName={primaryFile.fileName}
            kind="document"
            mimeType={primaryFile.mimeType}
          />
          <BidiText as="span" className="truncate">
            {primaryFile.fileName}
          </BidiText>
          {sourceFiles.length > 1 && (
            <span className="text-muted-foreground shrink-0">
              +{sourceFiles.length - 1}
            </span>
          )}
        </span>
      )}
      {visibleStatements.map((statement) => (
        <span className="flex w-full flex-col gap-1" key={statement.key}>
          <span className={statementTextClassName}>
            {statement.text}
            {statement.pages.map((page) => (
              <span
                className="border-border bg-muted/64 text-foreground-strong-muted ms-1 inline-flex shrink-0 items-center rounded-md border px-1 py-0 align-middle text-[10px] font-medium tracking-tight"
                key={page.key}
              >
                p.&nbsp;{page.pageNumber}
              </span>
            ))}
          </span>
          {statement.quotes.map((quote) => (
            <span
              className="text-muted-foreground line-clamp-3 text-justify text-xs leading-relaxed text-wrap hyphens-auto italic"
              key={quote.key}
            >
              "{quote.text}"
            </span>
          ))}
        </span>
      ))}
      {hiddenStatementCount > 0 && (
        <span className="text-muted-foreground text-xs">
          {t("workspaces.views.calendar.more", {
            count: String(hiddenStatementCount),
          })}
        </span>
      )}
      {flags.length > 0 && (
        <span className="flex w-full flex-col gap-1.5 border-t pt-2">
          {flags.map((flagId) => (
            <CellFlagProvenanceRow
              flagId={flagId}
              key={flagId}
              provenance={cellMetadata?.flagProvenance?.[flagId]}
            />
          ))}
        </span>
      )}
    </>
  );

  return (
    <PreviewCard onOpenChange={handleOpenChange} open={open}>
      <PreviewCardTrigger
        closeDelay={100}
        delay={650}
        render={
          onOpen === undefined ? (
            // Static provenance card (verdict rationale): the children carry no
            // interactive control, so without a focusable trigger keyboard users
            // have no way to reach the popup. It stays a role="button" div rather
            // than a real <button> because some cells nest interactive flag
            // controls in `children`, which <button> cannot legally wrap.
            <div
              className={triggerClassName ?? "w-full min-w-0"}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  dismissedRef.current = false;
                  setOpen(true);
                }
              }}
              onPointerDown={() => {
                dismissedRef.current = true;
                setOpen(false);
              }}
              onPointerLeave={() => {
                dismissedRef.current = false;
              }}
              role="button"
              tabIndex={0}
            />
          ) : (
            <div
              className={triggerClassName ?? "w-full min-w-0"}
              onPointerDown={() => {
                dismissedRef.current = true;
                setOpen(false);
              }}
              onPointerLeave={() => {
                dismissedRef.current = false;
              }}
            />
          )
        }
      >
        {children}
      </PreviewCardTrigger>
      <PreviewCardPopup align="start" className="w-80 p-0">
        {onOpen ? (
          <button
            className="hover:bg-accent/40 flex w-full cursor-pointer flex-col gap-2 rounded-lg p-3 text-start transition-colors"
            onClick={onOpen}
            type="button"
          >
            {cardContent}
          </button>
        ) : (
          <div className="flex w-full flex-col gap-2 rounded-lg p-3 text-start">
            {cardContent}
          </div>
        )}
      </PreviewCardPopup>
    </PreviewCard>
  );
};

type CellFlagProvenanceRowProps = {
  flagId: string;
  provenance:
    | NonNullable<WorkspaceCellMetadata["flagProvenance"]>[string]
    | undefined;
};

const CellFlagProvenanceRow = ({
  flagId,
  provenance,
}: CellFlagProvenanceRowProps) => {
  const getFlagLabel = useFlagLabel();
  const flag = getCellFlagById(flagId);
  if (!flag) {
    return null;
  }
  const Icon = flag.icon;
  const relativeTime = provenance
    ? formatRelativeTime(provenance.addedAt)
    : null;

  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs">
      <Icon className="size-3.5 shrink-0" style={{ color: flag.color }} />
      <span className="shrink-0 font-medium">{getFlagLabel(flag.id)}</span>
      {provenance && (
        <span className="text-muted-foreground flex min-w-0 items-center gap-1">
          <span className="shrink-0">·</span>
          <UserAvatar
            className="size-4 shrink-0 text-[7px]"
            image={provenance.addedByImage}
            name={provenance.addedByName}
          />
          <span className="truncate">
            {provenance.addedByName
              ? `${provenance.addedByName} · ${relativeTime}`
              : relativeTime}
          </span>
        </span>
      )}
    </span>
  );
};

// Each statement and quote clamps independently, so a long answer can
// never push the evidence out of the card (and vice versa).
const MAX_STATEMENTS = 2;

type CardStatement = {
  key: string;
  text: string;
  pages: { key: string; pageNumber: number }[];
  quotes: { key: string; text: string }[];
};

const flattenStatements = (content: JustificationContent): CardStatement[] => {
  const statements: CardStatement[] = [];
  for (const [blockIndex, block] of content.blocks.entries()) {
    if (block.kind === "pdf-bates") {
      for (const [statementIndex, statement] of block.statements.entries()) {
        const key = `${blockIndex}-${statementIndex}`;
        statements.push({
          key,
          text: statement.text,
          pages: statement.citations.map((citation, citationIndex) => ({
            key: `${key}-${citationIndex}`,
            pageNumber: citation.pageNumber,
          })),
          quotes: [],
        });
      }
      continue;
    }

    // A verdict block's provenance is its rationale; surface it as a single
    // statement so the card renders it like any other extraction explanation.
    // The matched fallback option or violated red-line rule is authored
    // standard language, so it renders as the statement's quote.
    if (block.kind === "playbook-verdict") {
      const matchedText = block.matchedRef?.text.trim();
      statements.push({
        key: `${blockIndex}-verdict`,
        text: block.rationale,
        pages: [],
        quotes: matchedText
          ? [{ key: `${blockIndex}-verdict-matched`, text: matchedText }]
          : [],
      });
      continue;
    }

    for (const [statementIndex, statement] of block.statements.entries()) {
      const key = `${blockIndex}-${statementIndex}`;
      statements.push({
        key,
        text: statement.text,
        pages: [],
        quotes: statement.citations.flatMap((citation, citationIndex) => {
          const text = citation.text.trim();
          return text ? [{ key: `${key}-${citationIndex}`, text }] : [];
        }),
      });
    }
  }
  return statements;
};

type SourceFile = {
  fieldId: FieldId;
  fileName: string;
  mimeType: string;
};

const resolveSourceFiles = (
  entity: WorkspaceEntity,
  justification: WorkspaceJustification,
): SourceFile[] => {
  const files: SourceFile[] = [];
  for (const fileFieldId of justification.fileFieldIds) {
    const field = Object.values(entity.fields).find(
      (f): f is WorkspaceField => f !== undefined && f.id === fileFieldId,
    );
    if (field?.content.type === "file") {
      files.push({
        fieldId: field.id,
        fileName: field.content.fileName,
        mimeType: field.content.mimeType,
      });
    }
  }
  return files;
};
