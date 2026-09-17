/**
 * The two slots a hosted DOCX editor can be shown in, and the gate that keeps
 * the live instances above both of them.
 *
 * A mount site renders `DocxEditorSlot` — an empty target div and a loading
 * shell — instead of the editor itself. `DocxEditorHost`, mounted once in the
 * protected shell above both the route outlet and the inspector, owns the
 * editor and moves its DOM node into whichever slot currently claims it. The
 * pane swap then costs a `Node.append`, not a refetch, a reparse, a relayout
 * and a dropped edit session.
 */

import { lazy, Suspense, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { useShallow } from "zustand/shallow";

import { cn } from "@stll/ui/utils";

import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";

import {
  nextDocxEditorSlotSequence,
  selectDocxEditorHostKeys,
  useDocxEditorHostStore,
} from "./docx-editor-host-store";
import { DOCX_EDITOR_SLOT, docxEditorHostKey } from "./docx-editor-host.logic";
import type {
  DocxEditorClaim,
  DocxEditorDocument,
  DocxEditorSlotBindings,
} from "./docx-editor-host.logic";

// The editor graph (Folio, prosemirror-tables, yjs, utif2, …) stays out of the
// eager preload: the host is only reached once a slot has claimed a document.
const LazyHostedDocxEditor = lazy(async () => {
  const m = await import("./docx-editor-host-instance");
  return { default: m.HostedDocxEditor };
});

/**
 * Mounted once, above both places a document can be read. Renders nothing
 * until a slot claims a document, so a page that shows no DOCX never pulls the
 * editor chunk.
 */
export const DocxEditorHost = () => {
  const hostKeys = useDocxEditorHostStore(useShallow(selectDocxEditorHostKeys));

  if (hostKeys.length === 0) {
    return null;
  }

  return (
    <Suspense fallback={null}>
      {hostKeys.map((hostKey) => (
        <LazyHostedDocxEditor hostKey={hostKey} key={hostKey} />
      ))}
    </Suspense>
  );
};

type DocxEditorSlotCommonProps = {
  /** Referentially stable for the slot's lifetime: wrap callbacks in
   *  `useLatestCallback` and pass refs the site already owns. */
  bindings: DocxEditorSlotBindings;
  canUnlock: boolean;
  className?: string | undefined;
  document: DocxEditorDocument;
  /** Drawn until the editor's DOM has actually landed in this slot. */
  fallback: ReactNode;
  isEditing: boolean;
  scaleOffset?: number | undefined;
};

export type DocxEditorSlotProps = DocxEditorSlotCommonProps &
  (
    | { slot: typeof DOCX_EDITOR_SLOT.main }
    | {
        slot: typeof DOCX_EDITOR_SLOT.inspector;
        initialScrollTop: number | undefined;
      }
  );

/**
 * Where a document is read. The host key is the instance's identity, so a
 * field-id replacement (a new version) is a new slot, while a pane swap is the
 * same one changing hands.
 */
export const DocxEditorSlot = (props: DocxEditorSlotProps) => {
  const hostKey = docxEditorHostKey(props.document);

  return <DocxEditorSlotInstance {...props} hostKey={hostKey} key={hostKey} />;
};

const DocxEditorSlotInstance = ({
  hostKey,
  ...props
}: DocxEditorSlotProps & { hostKey: string }) => {
  const {
    bindings,
    canUnlock,
    className,
    document,
    fallback,
    isEditing,
    slot,
  } = props;
  const scaleOffset = props.scaleOffset;
  const initialScrollTop =
    props.slot === DOCX_EDITOR_SLOT.inspector ? props.initialScrollTop : null;
  const [sequence] = useState(nextDocxEditorSlotSequence);
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const claimSlot = useDocxEditorHostStore((s) => s.claimSlot);
  const releaseSlot = useDocxEditorHostStore((s) => s.releaseSlot);
  const setSlotElement = useDocxEditorHostStore((s) => s.setSlotElement);
  const attachedSlot = useDocxEditorHostStore((s) => s.attachedSlots[hostKey]);

  // Constructed per branch rather than spread over a previous claim, so the
  // inspector's scroll position cannot leak into the full view's claim.
  const claim: DocxEditorClaim = useMemo(() => {
    const base = {
      bindings,
      canUnlock,
      document,
      isEditing,
      scaleOffset,
      sequence,
    };
    return slot === DOCX_EDITOR_SLOT.inspector
      ? {
          ...base,
          initialScrollTop: initialScrollTop ?? undefined,
          slot: DOCX_EDITOR_SLOT.inspector,
          surface: "inspector",
        }
      : { ...base, slot: DOCX_EDITOR_SLOT.main, surface: "fullView" };
  }, [
    bindings,
    canUnlock,
    document,
    initialScrollTop,
    isEditing,
    scaleOffset,
    sequence,
    slot,
  ]);

  useExternalSyncEffect(() => {
    claimSlot(hostKey, claim);
  }, [claim, claimSlot, hostKey]);

  useExternalSyncEffect(() => {
    setSlotElement({ element: target, hostKey, slot });
    return () =>
      setSlotElement({ element: null, hostKey, released: target, slot });
  }, [hostKey, setSlotElement, slot, target]);

  // Mount-scoped on purpose: the component is keyed by `hostKey`, so one
  // lifetime is one document, and the release always names what it claimed.
  useMountEffect(() => () => {
    releaseSlot({ hostKey, sequence, slot });
  });

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}>
      {attachedSlot === slot ? null : fallback}
      <div className="contents" ref={setTarget} />
    </div>
  );
};
