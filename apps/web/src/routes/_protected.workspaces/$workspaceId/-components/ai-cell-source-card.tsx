import { useLocale, useTranslations } from "use-intl";

import {
  PreviewCard,
  PreviewCardPopup,
  PreviewCardTrigger,
} from "@stll/ui/components/preview-card";

import { UserAvatar } from "@/components/user-avatar";
import { formatRelativeTime } from "@/lib/relative-time";
import type {
  JustificationContent,
  WorkspaceCellMetadata,
  WorkspaceEntity,
  WorkspaceJustification,
} from "@/lib/types";
import {
  cellFlagsById,
  useFlagLabel,
} from "@/routes/_protected.workspaces/$workspaceId/-components/cell-metadata-flags";
import { EntityKindIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/entity-kind-icon";
import { getFirstFile } from "@/routes/_protected.workspaces/$workspaceId/-utils";

type AICellSourceCardProps = React.PropsWithChildren<{
  entity: WorkspaceEntity;
  justification: WorkspaceJustification;
  cellMetadata: WorkspaceCellMetadata | undefined;
  /** Opens the cited document with this justification highlighted. */
  onOpen: () => void;
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
  children,
}: AICellSourceCardProps) => {
  const t = useTranslations();
  const flags = cellMetadata?.manualFlags ?? [];
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

  return (
    <PreviewCard>
      <PreviewCardTrigger
        closeDelay={100}
        delay={650}
        render={<div className="w-full min-w-0" />}
      >
        {children}
      </PreviewCardTrigger>
      <PreviewCardPopup align="start" className="w-80 p-0">
        <button
          className="hover:bg-accent/40 flex w-full cursor-pointer flex-col gap-2 rounded-lg p-3 text-start transition-colors"
          onClick={onOpen}
          type="button"
        >
          {showSourceFile && primaryFile && (
            <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
              <EntityKindIcon
                className="size-3.5 shrink-0"
                fileName={primaryFile.fileName}
                kind="document"
                mimeType={primaryFile.mimeType}
              />
              <span className="truncate">{primaryFile.fileName}</span>
              {sourceFiles.length > 1 && (
                <span className="text-muted-foreground shrink-0">
                  +{sourceFiles.length - 1}
                </span>
              )}
            </span>
          )}
          {visibleStatements.map((statement) => (
            <span className="flex w-full flex-col gap-1" key={statement.key}>
              <span className="line-clamp-3 text-justify text-xs leading-relaxed text-wrap hyphens-auto">
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
        </button>
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
  const locale = useLocale();
  const flag = cellFlagsById.get(flagId);
  if (!flag) {
    return null;
  }
  const Icon = flag.icon;
  const relativeTime = provenance
    ? formatRelativeTime(provenance.addedAt, locale)
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
  fieldId: string;
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
      (f) => f.id === fileFieldId,
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
