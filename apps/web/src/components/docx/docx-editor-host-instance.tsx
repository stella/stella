/**
 * One live Folio instance, portalled into a container the host owns and moved
 * between slots by hand.
 *
 * The container is created once and never replaced: React re-creates a portal
 * whose `containerInfo` changes, which would remount the editor and undo the
 * whole point. Moving the container with `Node.append` keeps the ProseMirror
 * view, the edit session, the collaboration room and the chat overlay alive —
 * Folio holds no iframe or shadow root and binds its observers to its own
 * refs. What a reparent does cost is the scroll offset and the DOM focus, and
 * Folio applies `initialScrollTop` only once per load, so this module restores
 * both itself.
 */

import { useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { DocxBrowserEditor } from "@/components/docx/docx-browser-editor";
import { InspectorPdfErrorFallback } from "@/components/inspector/inspector-pdf-error-fallback";
import { useExternalSyncEffect } from "@/hooks/use-effect";

import { DocxEditorActionBarOutlet } from "./docx-editor-action-bar";
import {
  selectDocxEditorClaim,
  selectDocxEditorSlotElement,
  useDocxEditorHostStore,
} from "./docx-editor-host-store";
import { DOCX_EDITOR_SLOT } from "./docx-editor-host.logic";
import type { DocxEditorSlotName } from "./docx-editor-host.logic";

/** The docked pane draws its own error surface; the full view keeps the
 *  editor's. Total over the slot vocabulary. */
const ERROR_FALLBACK_BY_SLOT = {
  [DOCX_EDITOR_SLOT.main]: undefined,
  [DOCX_EDITOR_SLOT.inspector]: ({ reset }: { reset: () => void }) => (
    <InspectorPdfErrorFallback onRetry={reset} />
  ),
} as const satisfies Record<
  DocxEditorSlotName,
  ((props: { reset: () => void }) => ReactNode) | undefined
>;

const createHostContainer = () => {
  const container = document.createElement("div");
  container.className = "flex h-full w-full min-w-0 flex-col";
  container.dataset["docxEditorHost"] = "";
  return container;
};

export const HostedDocxEditor = ({ hostKey }: { hostKey: string }) => {
  const claim = useDocxEditorHostStore((s) =>
    selectDocxEditorClaim(s, hostKey),
  );
  const slot = claim?.slot;
  const target = useDocxEditorHostStore((s) =>
    selectDocxEditorSlotElement(s, hostKey, slot),
  );
  const setAttachedSlot = useDocxEditorHostStore((s) => s.setAttachedSlot);
  const [container] = useState(createHostContainer);

  // The claim is read against the mounted slots, so `target` is null only while
  // no slot holds an element at all: the frame before the first slot registers
  // one, and the grace window. The instance then stays in its container.
  useExternalSyncEffect(() => {
    if (target === null || slot === undefined) {
      return;
    }
    if (container.parentElement !== target) {
      moveHostedEditor(container, target);
    }
    setAttachedSlot(hostKey, slot);
  }, [container, hostKey, setAttachedSlot, slot, target]);

  if (claim === null) {
    return null;
  }

  const { bindings, document: file } = claim;

  return createPortal(
    <DocxBrowserEditor
      actionBarControls={
        claim.slot === DOCX_EDITOR_SLOT.main ? (
          <DocxEditorActionBarOutlet hostKey={hostKey} />
        ) : undefined
      }
      actionsKey={bindings.actionsKey}
      actionsMapRef={bindings.actionsMapRef}
      actionsRef={bindings.actionsRef}
      canUnlock={claim.canUnlock}
      entityId={file.entityId}
      errorFallback={ERROR_FALLBACK_BY_SLOT[claim.slot]}
      fieldId={file.fileFieldId}
      initialScrollTop={
        claim.slot === DOCX_EDITOR_SLOT.inspector
          ? claim.initialScrollTop
          : undefined
      }
      isEditing={claim.isEditing}
      onBlockedUnlock={bindings.onBlockedUnlock}
      onClose={bindings.onClose}
      onCollaborationPublishableChange={
        bindings.onCollaborationPublishableChange
      }
      onCompatibilityChange={bindings.onCompatibilityChange}
      onError={bindings.onError}
      onSaved={bindings.onSaved}
      onScrollTopChange={bindings.onScrollTopChange}
      onUnlockedChange={bindings.onUnlockedChange}
      propertyId={file.propertyId}
      scaleOffset={claim.scaleOffset}
      showActionBar={claim.slot === DOCX_EDITOR_SLOT.main}
      surface={claim.surface}
      workspaceId={file.workspaceId}
    />,
    container,
  );
};

/**
 * Reparent the live editor. A DOM move drops the scroll offset of every
 * scroller inside the moved subtree and blurs whatever was focused, so both
 * are captured first and written back — once synchronously, once after layout,
 * because the new parent's box is not measured yet in the same tick.
 */
const moveHostedEditor = (container: HTMLElement, target: HTMLElement) => {
  const scrollers = [
    ...container.querySelectorAll<HTMLElement>("[data-folio-scroll]"),
  ].map((element) => ({ element, scrollTop: element.scrollTop }));
  const focused = document.activeElement;
  const refocus =
    focused instanceof HTMLElement && container.contains(focused)
      ? focused
      : null;

  target.append(container);

  const restore = () => {
    for (const { element, scrollTop } of scrollers) {
      if (element.scrollTop !== scrollTop) {
        element.scrollTop = scrollTop;
      }
    }
  };
  restore();
  requestAnimationFrame(restore);
  // ProseMirror writes the DOM selection back from its own state when the
  // contenteditable regains focus, so the caret survives with it.
  refocus?.focus({ preventScroll: true });
};
