import { useRef, useState } from "react";
import type { RefObject } from "react";

import { useTranslations } from "use-intl";

import { composerText } from "@/components/chat-editor-source";
import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import { FILE_CHAT_DRAFT_DELIVERY } from "@/components/inspector/inspector-store-types";
import type { FileChatDraftDelivery } from "@/components/inspector/inspector-store-types";
import {
  pdfPageLocator,
  pdfPassageCitation,
  pdfPassageCopyText,
  pdfSelectionPassage,
} from "@/components/pdf/pdf-selection.logic";
import type {
  PdfCitedDocument,
  PdfSelectionPassage,
} from "@/components/pdf/pdf-selection.logic";
import { SelectionToolbar } from "@/components/selection-toolbar";
import {
  SelectionAIActions,
  SelectionCopyMenu,
  useSelectionCopy,
} from "@/components/selection-toolbar-actions";
import { selectionToolbarAnchor } from "@/components/selection-toolbar.logic";
import { useMountEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { useMessageLocale } from "@/i18n/message-locale";

/**
 * Whether the viewer floats the document's chat composer, the only place a
 * passage handed to the AI can land. Without it the bar offers no AI action
 * rather than one that leads nowhere.
 */
export const PDF_SELECTION_CHAT = {
  fileChat: "file-chat",
  none: "none",
} as const;
export type PdfSelectionChat =
  (typeof PDF_SELECTION_CHAT)[keyof typeof PDF_SELECTION_CHAT];

type PdfSelectionDocument = PdfCitedDocument & {
  /** The file field whose chat the passage is handed to. */
  fileFieldId: string;
};

type PdfSelectionToolbarProps = {
  chat: PdfSelectionChat;
  citedDocument: PdfSelectionDocument;
  /** The viewer's page number for a text layer's page id. */
  pageNumberOf: (pageId: string) => number | null;
  /** The element holding the PDF's pages: only words inside it get the bar. */
  rootRef: RefObject<HTMLElement | null>;
};

type Selected = {
  bounds: DOMRect;
  passage: PdfSelectionPassage;
  rect: DOMRect;
};

/**
 * What a reader can do with words selected in a matter PDF: copy them with
 * the document's citation, or hand them to the document's chat. The bar is
 * the case-law reader's, without marks: a matter document has no annotation
 * store, so it offers none rather than a highlight that would not survive a
 * reload.
 *
 * Every DOM access goes through the viewer's own container, so the module
 * carries no browser global and renders nothing on the server.
 */
export const PdfSelectionToolbar = ({
  chat,
  citedDocument,
  pageNumberOf,
  rootRef,
}: PdfSelectionToolbarProps) => {
  const t = useTranslations();
  const locale = useMessageLocale();
  const barRef = useRef<HTMLDivElement | null>(null);
  const copyMenuRef = useRef<HTMLDivElement | null>(null);
  const attachBar = (node: HTMLDivElement | null) => {
    barRef.current = node;
  };
  const [doc, setDoc] = useState<Document | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const selectionCopy = useSelectionCopy();
  // The listeners below are installed once; the page list changes under them
  // as the document loads, so they read the latest one.
  const passageOf = useLatestCallback((range: Range, root: HTMLElement) =>
    pdfSelectionPassage({ pageNumberOf, range, root }),
  );

  useMountEffect(() => {
    const root = rootRef.current;
    if (root === null) {
      return undefined;
    }
    const ownerDoc = root.ownerDocument;
    setDoc(ownerDoc);
    let frame = 0;
    let dragActive = false;
    const isOnBar = (node: Node): boolean =>
      barRef.current?.contains(node) === true ||
      copyMenuRef.current?.contains(node) === true;
    // The bar appears once a pointer drag ends: painted mid-drag, it would sit
    // under the pointer and the drag would select across it.
    const readSelection = () => {
      cancelAnimationFrame(frame);
      if (dragActive) {
        setSelected(null);
        return;
      }
      frame = requestAnimationFrame(() => {
        const selection = ownerDoc.getSelection();
        if (
          dragActive ||
          selection === null ||
          selection.isCollapsed ||
          selection.rangeCount === 0 ||
          !root.contains(selection.anchorNode)
        ) {
          setSelected(null);
          return;
        }
        const range = selection.getRangeAt(0);
        const passage = passageOf(range, root);
        const geometry =
          passage === null ? null : selectionToolbarAnchor({ range, root });
        if (passage === null || geometry === null) {
          setSelected(null);
          return;
        }
        // A fresh selection must not inherit the previous one's open menu.
        setCopyOpen(false);
        setSelected({ bounds: geometry.bounds, passage, rect: geometry.rect });
      });
    };
    const selectionInside = (): boolean => {
      const selection = ownerDoc.getSelection();
      return (
        selection !== null &&
        !selection.isCollapsed &&
        root.contains(selection.anchorNode) &&
        root.contains(selection.focusNode)
      );
    };
    const onSelectionChange = () => {
      selectionCopy.selectionChanged();
      readSelection();
    };
    const onPointerDown = (event: PointerEvent) => {
      const pressed = event.target;
      if (pressed instanceof Node && isOnBar(pressed)) {
        return;
      }
      dragActive =
        event.button === 0 && pressed instanceof Node && root.contains(pressed);
    };
    const onPointerCancel = () => {
      dragActive = false;
    };
    const onPointerEnd = (event: PointerEvent) => {
      dragActive = false;
      if (event.target instanceof Node && isOnBar(event.target)) {
        return;
      }
      readSelection();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && selectionInside()) {
        ownerDoc.getSelection()?.removeAllRanges();
      }
    };
    const onCopy = () => {
      if (barRef.current !== null && selectionInside()) {
        selectionCopy.confirmNativeCopy();
      }
    };
    const onViewportChange = () => readSelection();
    ownerDoc.addEventListener("selectionchange", onSelectionChange);
    ownerDoc.addEventListener("copy", onCopy);
    ownerDoc.addEventListener("keydown", onKeyDown);
    ownerDoc.addEventListener("pointerdown", onPointerDown);
    ownerDoc.addEventListener("pointercancel", onPointerCancel);
    ownerDoc.addEventListener("pointerup", onPointerEnd);
    ownerDoc.addEventListener("scroll", onViewportChange, true);
    ownerDoc.defaultView?.addEventListener("resize", onViewportChange);
    const observer = new ResizeObserver(onViewportChange);
    observer.observe(root);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      ownerDoc.removeEventListener("selectionchange", onSelectionChange);
      ownerDoc.removeEventListener("copy", onCopy);
      ownerDoc.removeEventListener("keydown", onKeyDown);
      ownerDoc.removeEventListener("pointerdown", onPointerDown);
      ownerDoc.removeEventListener("pointercancel", onPointerCancel);
      ownerDoc.removeEventListener("pointerup", onPointerEnd);
      ownerDoc.removeEventListener("scroll", onViewportChange, true);
      ownerDoc.defaultView?.removeEventListener("resize", onViewportChange);
    };
  });

  if (selected === null) {
    return null;
  }

  const { passage } = selected;
  const citation = pdfPassageCitation({
    document: citedDocument,
    locator: pdfPageLocator(passage.pages, {
      page: (page) => t("workspaces.pdf.selection.pageLocator", { page }),
      pageRange: (start, end) =>
        t("workspaces.pdf.selection.pageRangeLocator", { end, start }),
    }),
  });
  const clearSelection = () => {
    doc?.getSelection()?.removeAllRanges();
    setSelected(null);
  };
  // The document's chat already carries the document, so the draft only has
  // to say which words are at issue and where they sit.
  const handToChat = (delivery: FileChatDraftDelivery, prompt: string) => {
    useInspectorCommandStore.getState().requestFileChatDraft({
      delivery,
      fileFieldId: citedDocument.fileFieldId,
      markdown: composerText(prompt),
    });
    clearSelection();
  };

  return (
    <SelectionToolbar
      anchorRect={selected.rect}
      boundaryRect={selected.bounds}
      doc={doc}
      onAttach={attachBar}
    >
      <div className="flex flex-wrap items-center gap-1">
        <SelectionCopyMenu
          barRef={barRef}
          copy={selectionCopy}
          doc={doc}
          menuRef={copyMenuRef}
          onOpenChange={setCopyOpen}
          open={copyOpen}
          quote={passage.quote}
          textFor={(mode, quote) =>
            pdfPassageCopyText({ citation, language: locale, mode, quote })
          }
        />
        {chat === PDF_SELECTION_CHAT.fileChat && (
          <SelectionAIActions
            onAsk={() => {
              handToChat(
                FILE_CHAT_DRAFT_DELIVERY.draft,
                t("legalReader.annotations.askPassagePrompt", {
                  citation: citation.inline,
                  quote: passage.quote,
                }),
              );
            }}
            onExplain={() => {
              handToChat(
                FILE_CHAT_DRAFT_DELIVERY.send,
                t("workspaces.pdf.selection.explainPassagePrompt", {
                  citation: citation.inline,
                  quote: passage.quote,
                }),
              );
            }}
          />
        )}
      </div>
    </SelectionToolbar>
  );
};
