/**
 * The document toolbar's route-owned controls, published into the hosted
 * editor's action bar.
 *
 * The editor lives above the route now, but its action bar carries controls
 * whose handlers and state belong to the route (page number, download
 * renditions, the translate dialog). Rather than pass a `ReactNode` through
 * the registry — which would rewrite the claim on every route render — the
 * host renders an outlet inside the action bar and the route portals its
 * controls into it. Same coupling as the chrome header: one DOM node.
 */

import { useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { create } from "zustand";

import { useExternalSyncEffect } from "@/hooks/use-effect";

import { docxEditorHostKey } from "./docx-editor-host.logic";
import type { DocxEditorDocument } from "./docx-editor-host.logic";

type DocxEditorActionBarStore = {
  containers: Readonly<Record<string, HTMLElement>>;
  setContainer: (args: {
    container: HTMLElement | null;
    hostKey: string;
    /** Which container is being released, so a teardown that lands after the
     *  next outlet registered cannot take the live one with it. */
    released?: HTMLElement | null;
  }) => void;
};

const useDocxEditorActionBarStore = create<DocxEditorActionBarStore>((set) => ({
  containers: {},
  setContainer: ({ container, hostKey, released }) => {
    set((state) => {
      if (container === null) {
        const held = state.containers[hostKey];
        if (
          held === undefined ||
          (released !== null && released !== undefined && held !== released)
        ) {
          return state;
        }
        const { [hostKey]: _dropped, ...rest } = state.containers;
        return { containers: rest };
      }
      if (state.containers[hostKey] === container) {
        return state;
      }
      return { containers: { ...state.containers, [hostKey]: container } };
    });
  },
}));

/**
 * Rendered by the host inside the editor's action bar. The store write is a
 * passive effect rather than a ref callback: a subscriber's
 * `useSyncExternalStore` registration is not committed during the layout
 * sub-phase, and React 19 flags a notification that early.
 */
export const DocxEditorActionBarOutlet = ({ hostKey }: { hostKey: string }) => {
  const setContainer = useDocxEditorActionBarStore((s) => s.setContainer);
  const [container, setElement] = useState<HTMLDivElement | null>(null);

  useExternalSyncEffect(() => {
    setContainer({ container, hostKey });
    return () =>
      setContainer({ container: null, hostKey, released: container });
  }, [container, hostKey, setContainer]);

  return <div className="contents" ref={setElement} />;
};

/** Renders nothing until the hosted editor's action bar has mounted. */
export const DocxEditorActionBar = ({
  children,
  document,
}: {
  children: ReactNode;
  document: DocxEditorDocument;
}) => {
  const container = useDocxEditorActionBarStore(
    (s) => s.containers[docxEditorHostKey(document)],
  );

  if (container === undefined) {
    return null;
  }

  return createPortal(children, container);
};
