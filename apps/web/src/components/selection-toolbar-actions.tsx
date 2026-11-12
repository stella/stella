import { useId, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";

import { useTranslations } from "use-intl";

import { READER_COPY_MODES } from "@stll/api-contract/legal-reader-annotations";
import type { ReaderCopyMode } from "@stll/api-contract/legal-reader-annotations";
import { Button } from "@stll/ui/button";
import {
  ChevronDownIcon,
  CopyFromMenuIcon,
  SparklesIcon,
} from "@stll/ui/icons";
import { OVERLAY_LAYER_CLASS_NAMES } from "@stll/ui/overlay-layer";
import { MenuPreviewLayout, PreviewPane } from "@stll/ui/preview-pane";
import { cn } from "@stll/ui/utils";

import {
  CopyControlFeedback,
  useCopyControlLabel,
} from "@/components/copy-control";
import type { CopyControlState } from "@/components/copy-control";
import { readerCopyMenuBox } from "@/components/legal-reader/annotations/reader-copy-menu.logic";
import type { ReaderCopyMenuBox } from "@/components/legal-reader/annotations/reader-copy-menu.logic";
import { previewQuotation } from "@/components/legal-reader/citation-copy.logic";
import type { SelectionCopyText } from "@/components/selection-toolbar-copy.logic";
import { detached } from "@/lib/detached";
import {
  CapabilityAction,
  CapabilityActionChrome,
} from "@/lib/organization/feature-access/capability-actions";

const MENU_ESTIMATED_HEIGHT_PX = 200;
// Room for the options and a readable preview beside them.
const MENU_MIN_WIDTH_PX = 416;

type SelectionCopyMenuProps = {
  /** The bar the menu opens from, for placement and the focus return. */
  barRef: RefObject<HTMLDivElement | null>;
  /** The bar's Copy, which also confirms the reader's own copy. */
  copy: CopyControlState<"selection">;
  doc: Document | null;
  /** Receives the portalled menu, so the host can tell a press on it from a
   *  press on the text. */
  menuRef: RefObject<HTMLDivElement | null>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  quote: string;
  /** The copy each choice writes for these words. */
  textFor: (mode: ReaderCopyMode, quote: string) => SelectionCopyText;
};

/**
 * Copy, with a menu of citation formats each previewed as the reader hovers
 * or focuses it. Nothing in it moves focus on press, so the selection the
 * choices quote survives the click.
 */
export const SelectionCopyMenu = ({
  barRef,
  copy,
  doc,
  menuRef,
  onOpenChange,
  open,
  quote,
  textFor,
}: SelectionCopyMenuProps) => {
  const t = useTranslations();
  const [previewMode, setPreviewMode] = useState<ReaderCopyMode | null>(null);
  // Preserve the text selection while positioning the portaled menu in the
  // viewport; open upward when the space below the trigger cannot fit it.
  const [menuBox, setMenuBox] = useState<ReaderCopyMenuBox | null>(null);
  const previewQuote = previewQuotation(quote);
  const copyLabel = useCopyControlLabel(copy);

  return (
    <div className="relative">
      <Button
        aria-label={copyLabel}
        data-copy-trigger=""
        onClick={(event) => {
          const barRect = barRef.current?.getBoundingClientRect();
          const view = event.currentTarget.ownerDocument.defaultView;
          if (barRect !== undefined && view !== null) {
            setMenuBox(
              readerCopyMenuBox({
                bar: barRect,
                menuHeight: MENU_ESTIMATED_HEIGHT_PX,
                menuWidth: MENU_MIN_WIDTH_PX,
                viewport: {
                  height: view.innerHeight,
                  width: view.innerWidth,
                },
              }),
            );
          }
          setPreviewMode(null);
          onOpenChange(!open);
        }}
        size="sm"
        variant="ghost"
      >
        <CopyControlFeedback control={copy} icon={CopyFromMenuIcon} />
        <ChevronDownIcon className="size-3" />
      </Button>
      {open &&
        doc !== null &&
        createPortal(
          <div
            className={cn(
              "bg-popover text-popover-foreground fixed rounded-md border p-1 shadow-md",
              OVERLAY_LAYER_CLASS_NAMES.popup,
            )}
            ref={menuRef}
            style={menuBox ?? undefined}
          >
            <MenuPreviewLayout
              preview={
                // The menu's width is set from the toolbar, so the pane
                // gets what the options leave. A citation longer than the
                // box scrolls inside it rather than losing its last lines.
                <PreviewPane className="w-full" overflow="scroll">
                  {previewMode !== null && (
                    <p className="text-foreground text-2xs leading-snug whitespace-pre-wrap">
                      {textFor(previewMode, previewQuote).segments.map(
                        (segment) =>
                          segment.emphasis ? (
                            <em key={`emphasis:${segment.text}`}>
                              {segment.text}
                            </em>
                          ) : (
                            <span key={`plain:${segment.text}`}>
                              {segment.text}
                            </span>
                          ),
                      )}
                    </p>
                  )}
                </PreviewPane>
              }
              previewWidth="remaining"
            >
              {READER_COPY_MODES.map((copyMode) => (
                <Button
                  className="block w-full"
                  focusRing="inside"
                  variant="plain"
                  key={copyMode}
                  onClick={() => {
                    detached(
                      copy.copy(textFor(copyMode, quote)),
                      "selection-toolbar.copy",
                    );
                    onOpenChange(false);
                    // The option unmounts with the menu; keep keyboard
                    // focus on the trigger that now shows the confirmation.
                    barRef.current
                      ?.querySelector<HTMLElement>("[data-copy-trigger]")
                      ?.focus();
                  }}
                  onFocus={() => setPreviewMode(copyMode)}
                  onMouseEnter={() => setPreviewMode(copyMode)}
                >
                  <span className="hover:bg-accent block rounded-sm px-2 py-1.5 text-xs whitespace-nowrap">
                    {t(`legalReader.copyMenu.${copyMode}`)}
                  </span>
                </Button>
              ))}
            </MenuPreviewLayout>
          </div>,
          doc.body,
        )}
    </div>
  );
};

type SelectionAIActionsProps = {
  onAsk: () => void;
  /** Absent where the surface has no explanation to offer. */
  explainLanguagePicker?: ReactNode;
  onExplain?: (() => void) | undefined;
  /** Why Explain cannot take this selection, or `undefined` when it can. */
  explainRefusal?: string | undefined;
};

/** Ask AI and Explain over selected words, behind the AI capability. */
export const SelectionAIActions = ({
  onAsk,
  onExplain,
  explainLanguagePicker,
  explainRefusal,
}: SelectionAIActionsProps) => {
  const t = useTranslations();
  const explainReasonId = useId();

  return (
    <>
      <CapabilityActionChrome action={{ capability: "ai" }}>
        <span className="bg-border mx-1 h-4 w-px" />
      </CapabilityActionChrome>
      <CapabilityAction action={{ capability: "ai" }} surface="control">
        {(capabilityProps) => (
          <Button
            onClick={onAsk}
            size="sm"
            variant="ghost"
            {...capabilityProps}
          >
            <SparklesIcon className="size-3.5" />
            {t("common.askAI")}
          </Button>
        )}
      </CapabilityAction>
      {onExplain !== undefined && explainLanguagePicker}
      {onExplain !== undefined &&
        (explainRefusal === undefined ? (
          <CapabilityAction action={{ capability: "ai" }} surface="control">
            {(capabilityProps) => (
              <Button
                onClick={onExplain}
                size="sm"
                variant="ghost"
                {...capabilityProps}
              >
                <SparklesIcon className="size-3.5" />
                {t("readerAnswers.explain")}
              </Button>
            )}
          </CapabilityAction>
        ) : (
          <>
            <Button
              aria-describedby={explainReasonId}
              disabled
              size="sm"
              variant="ghost"
            >
              <SparklesIcon className="size-3.5" />
              {t("readerAnswers.explain")}
            </Button>
            <span
              className="text-muted-foreground px-2 text-xs"
              id={explainReasonId}
            >
              {explainRefusal}
            </span>
          </>
        ))}
    </>
  );
};
