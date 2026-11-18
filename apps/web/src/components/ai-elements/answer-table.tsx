import { useContext, useRef, useState } from "react";
import type { ComponentProps, ReactNode, RefObject } from "react";

import type { Element } from "hast";
import { StreamdownContext } from "streamdown";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Dialog, DIALOG_MOBILE_LAYOUT, DialogPopup } from "@stll/ui/dialog";
import {
  AlignJustifyIcon,
  CopyFromMenuIcon,
  DownloadIcon,
  Maximize2Icon,
  WrapTextIcon,
} from "@stll/ui/icons";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@stll/ui/menu";
import {
  fadeScrollEdges,
  SCROLL_EDGE_FADE_CLASS,
} from "@stll/ui/scroll-edge-fade";
import { SegmentedIconToggle } from "@stll/ui/segmented-icon-toggle";
import { Separator } from "@stll/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/table";
import { ToolbarIconAction } from "@stll/ui/toolbar-icon-action";
import { cn } from "@stll/ui/utils";

import {
  type AnswerTableTextMode,
  useAnswerTableTextModeStore,
} from "@/components/ai-elements/answer-table-text-mode-store";
import {
  answerTableShape,
  answerTableText,
  type AnswerTableTextFormat,
} from "@/components/ai-elements/answer-table.logic";
import { AnswerTreeIds } from "@/components/ai-elements/message-response-link-ids";
import {
  CopyControlFeedback,
  useCopyControl,
  useCopyControlLabel,
} from "@/components/copy-control";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import type { TranslationKey } from "@/i18n/types";
import { detached } from "@/lib/detached";
import { downloadFile } from "@/lib/utils";

/** What the markdown renderer hands an element: its props and parsed node. */
type MarkdownProps<Tag extends "table" | "thead" | "tbody" | "tr"> = Omit<
  ComponentProps<Tag>,
  "className"
> & { className?: string | undefined; node?: Element | undefined };
// The renderer turns a column's alignment into an inline style, never into
// the obsolete `align` attribute the table cells type differently.
type MarkdownCellProps<Tag extends "th" | "td"> = Omit<
  ComponentProps<Tag>,
  "align" | "className"
> & { className?: string | undefined; node?: Element | undefined };

/** A markdown table as the renderer hands it over. */
export type MarkdownTableProps = MarkdownProps<"table">;

export type AnswerTableProps = MarkdownTableProps & {
  /** Controls for this table placed in its header strip (a chart toggle). */
  actions?: ReactNode;
  /** A line between the header strip and the table, such as a status. */
  notice?: ReactNode;
  /**
   * Shown in place of the table while set (a chart of it). The table stays
   * mounted, so copy and download still read it.
   */
  view?: ReactNode;
};

/**
 * Every markdown table in an answer: one card with one header strip that
 * holds the table's size and all of its actions, then the table. Cells wrap
 * by default; single-line mode keeps each cell on one line and scrolls the
 * table sideways, fading the edge that has more to show. The whole table is
 * always shown: it is part of the answer, so it never collapses.
 */
export const AnswerTable = ({
  actions,
  children,
  className: _className,
  node,
  notice,
  view,
  ...props
}: AnswerTableProps) => {
  const t = useTranslations();
  const { isAnimating, tableMaxHeight } = useContext(StreamdownContext);
  const mode = useAnswerTableTextModeStore((state) => state.mode);
  const [fullscreen, setFullscreen] = useState(false);
  const tableRef = useRef<HTMLTableElement>(null);
  const dialogTableRef = useRef<HTMLTableElement>(null);
  const shape = answerTableShape(node);
  const label =
    shape === null ? null : t("chat.answerTable.size", { ...shape });
  const maxHeight = cssLength(tableMaxHeight);
  const showsView = view !== undefined && view !== null;
  const streaming = useLatestCallback(() => isAnimating);
  // While the answer streams into a table taller than its frame, the frame
  // follows the newest row unless the reader scrolled away from it.
  const scrollerRef = (scroller: HTMLDivElement | null) => {
    const stopFading = fadeScrollEdges(scroller);
    if (scroller === null) {
      return undefined;
    }
    let atEnd = true;
    const onScroll = () => {
      atEnd =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <
        END_TOLERANCE_PX;
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const resizes = new ResizeObserver(() => {
      if (atEnd && streaming()) {
        scroller.scrollTop = scroller.scrollHeight;
      }
    });
    if (scroller.firstElementChild !== null) {
      resizes.observe(scroller.firstElementChild);
    }
    return () => {
      stopFading?.();
      scroller.removeEventListener("scroll", onScroll);
      resizes.disconnect();
    };
  };

  return (
    <div
      className="bg-card my-4 min-w-0 overflow-hidden rounded-lg border"
      data-slot="answer-table"
      data-streamdown="table-wrapper"
      data-text-mode={mode}
    >
      <AnswerTableHeader
        actions={actions}
        disabled={isAnimating}
        label={label}
        mode={showsView ? null : mode}
        onFullscreen={() => setFullscreen(true)}
        tableRef={tableRef}
      />
      {notice}
      {view}
      <div hidden={showsView}>
        <div
          className={cn("overflow-auto", SCROLL_EDGE_FADE_CLASS)}
          data-slot="answer-table-scroller"
          ref={scrollerRef}
          style={maxHeight === undefined ? undefined : { maxHeight }}
        >
          <Table
            cellText={mode}
            data-streamdown="table"
            density="prose"
            ref={tableRef}
            scroll="parent"
            {...props}
          >
            {children}
          </Table>
        </div>
      </div>
      <Dialog onOpenChange={setFullscreen} open={fullscreen}>
        <DialogPopup
          aria-label={t("chat.answerTable.fullscreenTitle")}
          className="h-[calc(100dvh-4rem)] max-w-[min(96rem,calc(100vw-4rem))]"
          mobileLayout={DIALOG_MOBILE_LAYOUT.fullscreen}
        >
          <AnswerTableHeader
            disabled={isAnimating}
            label={label}
            mode={mode}
            tableRef={dialogTableRef}
          />
          <div
            className={cn(
              "min-h-0 flex-1 overflow-auto",
              SCROLL_EDGE_FADE_CLASS,
            )}
            ref={fadeScrollEdges}
          >
            {/* The second rendering of the answer's links takes ids of its
                own, so the open dialog repeats none of the answer's. */}
            <AnswerTreeIds prefix={undefined}>
              <Table
                cellText={mode}
                data-streamdown="table"
                density="prose"
                ref={dialogTableRef}
                scroll="parent"
                {...props}
              >
                {children}
              </Table>
            </AnswerTreeIds>
          </div>
        </DialogPopup>
      </Dialog>
    </div>
  );
};

/** The header row stays in view while the rows scroll under it. */
export const AnswerTableHead = ({
  className: _className,
  node: _node,
  ...props
}: MarkdownProps<"thead">) => (
  <TableHeader data-streamdown="table-header" sticky {...props} />
);

export const AnswerTableBody = ({
  className: _className,
  node: _node,
  ...props
}: MarkdownProps<"tbody">) => (
  <TableBody data-streamdown="table-body" {...props} />
);

export const AnswerTableRow = ({
  className: _className,
  node: _node,
  ...props
}: MarkdownProps<"tr">) => <TableRow data-streamdown="table-row" {...props} />;

export const AnswerTableHeaderCell = ({
  className: _className,
  node: _node,
  ...props
}: MarkdownCellProps<"th">) => (
  <TableHead data-streamdown="table-header-cell" {...props} />
);

export const AnswerTableCell = ({
  className: _className,
  node: _node,
  ...props
}: MarkdownCellProps<"td">) => (
  <TableCell data-streamdown="table-cell" {...props} />
);

const COPY_FORMATS = [
  { format: "md", name: "Markdown" },
  { format: "csv", name: "CSV" },
  { format: "tsv", name: "TSV" },
] as const satisfies readonly { format: AnswerTableTextFormat; name: string }[];

const DOWNLOAD_FORMATS = [
  { format: "csv", name: "CSV", type: "text/csv" },
  { format: "md", name: "Markdown", type: "text/markdown" },
] as const satisfies readonly {
  format: AnswerTableTextFormat;
  name: string;
  type: string;
}[];

const TEXT_MODE_OPTIONS = [
  { mode: "wrap", icon: WrapTextIcon, labelKey: "chat.answerTable.wrap" },
  {
    mode: "single-line",
    icon: AlignJustifyIcon,
    labelKey: "chat.answerTable.singleLine",
  },
] as const satisfies readonly {
  mode: AnswerTableTextMode;
  icon: typeof WrapTextIcon;
  labelKey: TranslationKey;
}[];

type AnswerTableHeaderProps = {
  actions?: ReactNode;
  /** While the answer streams the table is incomplete, so nothing acts on it. */
  disabled: boolean;
  label: string | null;
  /** The text mode control, or `null` while something else shows. */
  mode: AnswerTableTextMode | null;
  /** Absent inside the full-screen view itself. */
  onFullscreen?: () => void;
  tableRef: RefObject<HTMLTableElement | null>;
};

const AnswerTableHeader = ({
  actions,
  disabled,
  label,
  mode,
  onFullscreen,
  tableRef,
}: AnswerTableHeaderProps) => {
  const t = useTranslations();
  const setMode = useAnswerTableTextModeStore((state) => state.setMode);
  // Each format writes a different text, so only a chosen one confirms.
  const copy = useCopyControl({ confirmation: "in-place" });
  const copyLabel = useCopyControlLabel(copy, t("chat.answerTable.copy"));
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-end gap-x-3 gap-y-1 border-b px-3 py-1.5 select-none",
        // The full-screen view's close button sits in its top corner.
        onFullscreen === undefined && "py-2.5 pe-12",
      )}
      data-slot="answer-table-header"
    >
      {label !== null && (
        <span className="text-muted-foreground me-auto text-xs tabular-nums">
          {label}
        </span>
      )}
      <div className="flex flex-wrap items-center gap-1">
        {actions}
        {mode !== null && (
          <SegmentedIconToggle
            onChange={setMode}
            options={TEXT_MODE_OPTIONS.map((option) => ({
              value: option.mode,
              icon: option.icon,
              label: t(option.labelKey),
            }))}
            value={mode}
          />
        )}
        <Separator className="mx-1 h-4" orientation="vertical" />
        <Menu>
          <MenuTrigger
            disabled={disabled}
            render={
              <Button
                aria-label={copyLabel}
                data-copied={copy.copied ? "" : undefined}
                size="icon-xs"
                variant="ghost"
              />
            }
            tooltip={copyLabel}
          >
            <CopyControlFeedback
              control={copy}
              icon={CopyFromMenuIcon}
              iconOnly
            />
          </MenuTrigger>
          <MenuPopup align="end">
            {COPY_FORMATS.map(({ format, name }) => (
              <MenuItem
                key={format}
                onClick={() => {
                  const table = tableRef.current;
                  if (table === null) {
                    return;
                  }
                  detached(
                    copy.copy({
                      plain: answerTableText(table, format),
                      html: table.outerHTML,
                    }),
                    "answer-table.copy",
                  );
                }}
              >
                {t("chat.answerTable.copyAs", { format: name })}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
        <Menu>
          <MenuTrigger
            disabled={disabled}
            render={
              <Button
                aria-label={t("chat.answerTable.download")}
                size="icon-xs"
                variant="ghost"
              />
            }
            tooltip={t("chat.answerTable.download")}
          >
            <DownloadIcon aria-hidden="true" />
          </MenuTrigger>
          <MenuPopup align="end">
            {DOWNLOAD_FORMATS.map(({ format, name, type }) => (
              <MenuItem
                key={format}
                onClick={() => {
                  const table = tableRef.current;
                  if (table === null) {
                    return;
                  }
                  downloadFile(
                    new Blob([answerTableText(table, format)], { type }),
                    `table.${format}`,
                  );
                }}
              >
                {t("chat.answerTable.downloadAs", { format: name })}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
        {onFullscreen !== undefined && (
          <ToolbarIconAction
            density="toolbar"
            disabled={disabled}
            icon={<Maximize2Icon aria-hidden="true" />}
            label={t("chat.answerTable.fullscreen")}
            onClick={onFullscreen}
          />
        )}
      </div>
    </div>
  );
};

/** Within this distance of the end, a scroller counts as at its end. */
const END_TOLERANCE_PX = 4;

/** Streamdown's table height setting as a CSS length, or none for no cap. */
const cssLength = (value: number | string): string | undefined => {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? `${value}px` : undefined;
  }
  return value === "" || value === "0" || value === "none" ? undefined : value;
};
