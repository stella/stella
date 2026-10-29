import { useId, useRef, useState } from "react";
import type { RefObject } from "react";
import { createPortal } from "react-dom";

import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { READER_COPY_MODES } from "@stll/api-contract/legal-reader-annotations";
import type { ReaderCopyMode } from "@stll/api-contract/legal-reader-annotations";
import { copyRichToClipboard } from "@stll/clipboard";
import { Button } from "@stll/ui/button";
import { CopyFeedback, useCopiedFeedback } from "@stll/ui/copy-button";
import {
  ChevronDownIcon,
  CopyFromMenuIcon,
  SparklesIcon,
} from "@stll/ui/icons";
import { OVERLAY_LAYER_CLASS_NAMES } from "@stll/ui/overlay-layer";
import { MenuPreviewLayout, PreviewPane } from "@stll/ui/preview-pane";
import { cn } from "@stll/ui/utils";

import { readerCopyMenuBox } from "@/components/legal-reader/annotations/reader-copy-menu.logic";
import type { ReaderCopyMenuBox } from "@/components/legal-reader/annotations/reader-copy-menu.logic";
import { previewQuotation } from "@/components/legal-reader/citation-copy.logic";
import type { SelectionCopyText } from "@/components/selection-toolbar-copy.logic";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { detached } from "@/lib/detached";
import { notifyUserError } from "@/lib/errors/user-toast";
import {
  CapabilityAction,
  CapabilityActionChrome,
} from "@/lib/organization/feature-access/capability-actions";

const MENU_ESTIMATED_HEIGHT_PX = 200;
// Room for the options and a readable preview beside them.
const MENU_MIN_WIDTH_PX = 416;

type SelectionCopy = {
  copied: boolean;
  /** The reader copied the selected words themselves (Cmd+C). */
  confirmNativeCopy: () => void;
  /** Every selection change: a confirmation belongs to the words copied. */
  selectionChanged: () => void;
  write: (text: SelectionCopyText) => void;
};

/**
 * The clipboard half of a selection bar. Every function keeps one identity,
 * so a host may hand them to listeners it installs once.
 */
export const useSelectionCopy = (): SelectionCopy => {
  const t = useTranslations();
  const { copied, confirm, reset } = useCopiedFeedback();
  // Counts selection changes, so a clipboard write that settles after the
  // reader moved on to other words never confirms a copy of those words.
  const generationRef = useRef(0);
  const selectionChanged = useLatestCallback(() => {
    generationRef.current += 1;
    reset();
  });
  const write = (text: SelectionCopyText) => {
    const generation = generationRef.current;
    detached(
      (async () => {
        const copyResult = await copyRichToClipboard(text);
        if (Result.isError(copyResult)) {
          notifyUserError(copyResult.error, t("errors.actionFailed"));
          return;
        }
        if (generation === generationRef.current) {
          confirm();
        }
      })(),
      "selection-toolbar.copy",
    );
  };
  return {
    copied,
    confirmNativeCopy: confirm,
    selectionChanged,
    write,
  };
};

type SelectionCopyMenuProps = {
  /** The bar the menu opens from, for placement and the focus return. */
  barRef: RefObject<HTMLDivElement | null>;
  copy: SelectionCopy;
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

  return (
    <div className="relative">
      <Button
        aria-label={copy.copied ? t("common.copied") : t("common.copy")}
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
        onMouseDown={(event) => event.preventDefault()}
        size="sm"
        variant="ghost"
      >
        <CopyFeedback
          copied={copy.copied}
          copiedLabel={t("common.copied")}
          icon={CopyFromMenuIcon}
          label={t("common.copy")}
        />
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
                    copy.write(textFor(copyMode, quote));
                    onOpenChange(false);
                    // The option unmounts with the menu; keep keyboard
                    // focus on the trigger that now shows the confirmation.
                    barRef.current
                      ?.querySelector<HTMLElement>("[data-copy-trigger]")
                      ?.focus();
                  }}
                  onFocus={() => setPreviewMode(copyMode)}
                  onMouseDown={(event) => event.preventDefault()}
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
  onExplain?: (() => void) | undefined;
  /** Why Explain cannot take this selection, or `undefined` when it can. */
  explainRefusal?: string | undefined;
};

/** Ask AI and Explain over selected words, behind the AI capability. */
export const SelectionAIActions = ({
  onAsk,
  onExplain,
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
