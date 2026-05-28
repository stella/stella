/**
 * HiddenHeaderFooterPMs — persistent off-screen ProseMirror EditorViews for
 * every distinct header/footer part in the loaded document.
 *
 * Mounts one hidden EditorView per distinct HF `rId` from
 * `Document.package.headers ∪ Document.package.footers`. The views never
 * become the visible HF renderer — the painter is the sole visible HF
 * renderer in both edit and non-edit modes. The persistent views own the
 * source of truth for HF content while the document is loaded; the
 * painter reads each rId's `view.state.doc` through
 * `convertHeaderFooterPmDocToContent`.
 *
 * Slot keying is by `rId`, NOT by `(hdrFtrType, kind)` — two sections that
 * share a header by referencing the same `rId` (ECMA-376 §17.10.1
 * sharing-by-reference) share one EditorView, so an edit on any painted
 * instance propagates to every painted instance in one layout pass.
 *
 * Unlike upstream's in-place `hf.content` mutation, folio's history-immutable
 * model surfaces every transaction through `onTransaction`; the parent
 * (`useHeaderFooterEditor` / `DocxEditor`) is the only place that pushes
 * Document changes through history.
 */

import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import type { CSSProperties } from "react";

import { EditorState } from "prosemirror-state";
import type { EditorState as EditorStateT } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

import { headerFooterToProseDoc } from "../core/prosemirror/conversion/toProseDoc";
import { ExtensionManager } from "../core/prosemirror/extensions/ExtensionManager";
import { createStarterKit } from "../core/prosemirror/extensions/StarterKit";
import { schema } from "../core/prosemirror/schema";
import type {
  Document,
  HeaderFooter,
  StyleDefinitions,
  Theme,
} from "../core/types/document";

import "prosemirror-view/style/prosemirror.css";

// =============================================================================
// TYPES
// =============================================================================

export type HfPartKind = "header" | "footer";

export type HfPartKey = {
  /** Part-relationship id (`rId`) — the spec-faithful slot identity. */
  rId: string;
  /** Whether this rId belongs to `package.headers` or `package.footers`. */
  kind: HfPartKind;
};

export type HiddenHeaderFooterPMsRef = {
  /**
   * Look up the persistent EditorView for a given HF part. Returns `null`
   * before mount or when the rId is not present in the loaded document.
   */
  getView(rId: string): EditorView | null;
  /**
   * Enumerate every currently mounted slot. Used by the pointer pipeline
   * to translate painted DOM targets back to the owning PM view.
   */
  listSlots(): HfPartKey[];
};

export type HiddenHeaderFooterPMsProps = {
  /** Loaded document — its `package.headers`/`.footers` drives slot enumeration. */
  document: Document | null;
  /** Document styles, threaded into `headerFooterToProseDoc` for style resolution. */
  styles?: StyleDefinitions | null;
  /** Document theme, threaded for themed cell shading on initial PM build. */
  theme?: Theme | null;
  /** `defaultTabStop` from the body PM doc, threaded to the HF PM doc. */
  defaultTabStopTwips?: number | null;
  /**
   * Fires after every transaction lands on any HF EditorView. Parent uses
   * this to trigger relayout (so the painter repaints the new PM doc),
   * write back into `Document.package.headers/footers[rId]`, and drive the
   * HF caret overlay from the new selection.
   */
  onTransaction?: (
    rId: string,
    kind: HfPartKind,
    view: EditorView,
    docChanged: boolean,
    selectionChanged: boolean,
  ) => void;
};

// =============================================================================
// IMPLEMENTATION
// =============================================================================

type MountedView = {
  rId: string;
  kind: HfPartKind;
  view: EditorView;
  /** DOM node `view` is mounted on (one `<div>` per rId inside the off-screen host). */
  mountNode: HTMLElement;
};

function buildInitialState(
  hf: HeaderFooter,
  styles: StyleDefinitions | null | undefined,
  theme: Theme | null | undefined,
  mgr: ExtensionManager,
): EditorStateT {
  const proseDocOptions: { styles?: StyleDefinitions; theme?: Theme | null } =
    {};
  if (styles) {
    proseDocOptions.styles = styles;
  }
  if (theme !== undefined) {
    proseDocOptions.theme = theme;
  }
  const pmDoc = headerFooterToProseDoc(hf.content, proseDocOptions);
  return EditorState.create({
    doc: pmDoc,
    schema,
    plugins: mgr.getPlugins(),
  });
}

export function enumerateHfSlots(doc: Document | null): HfPartKey[] {
  if (!doc?.package) {
    return [];
  }
  const out: HfPartKey[] = [];
  const headers = doc.package.headers;
  if (headers) {
    for (const rId of headers.keys()) {
      out.push({ rId, kind: "header" });
    }
  }
  const footers = doc.package.footers;
  if (footers) {
    // A document SHOULD NOT register the same rId under both headers and
    // footers — the OOXML schema keeps them disjoint per
    // `headerReference` vs `footerReference`. Defensive: dedupe anyway.
    for (const rId of footers.keys()) {
      if (!headers || !headers.has(rId)) {
        out.push({ rId, kind: "footer" });
      }
    }
  }
  return out;
}

// =============================================================================
// STYLES
// =============================================================================

const HOST_STYLES: CSSProperties = {
  position: "fixed",
  left: -9999,
  top: 0,
  opacity: 0,
  zIndex: -1,
  pointerEvents: "none",
};

// =============================================================================
// COMPONENT
// =============================================================================

export const HiddenHeaderFooterPMs = memo(
  forwardRef<HiddenHeaderFooterPMsRef, HiddenHeaderFooterPMsProps>(
    function HiddenHeaderFooterPMs(
      { document, styles, theme, onTransaction },
      ref,
    ) {
      // Stable callback ref so re-renders don't recreate every EditorView.
      const onTransactionRef = useRef(onTransaction);
      onTransactionRef.current = onTransaction;

      const hostRef = useRef<HTMLDivElement>(null);
      const mountedRef = useRef<Map<string, MountedView>>(new Map());
      const managersRef = useRef<Map<string, ExtensionManager>>(new Map());
      // Latest document captured in a ref so resolveHf has a stable identity
      // and the mount-effect doesn't re-run on every body PM transaction
      // (each pushDocument returns a new Document identity).
      const documentRef = useRef(document);
      documentRef.current = document;

      const resolveHf = useCallback(
        (rId: string, kind: HfPartKind): HeaderFooter | null => {
          const pkg = documentRef.current?.package;
          if (!pkg) {
            return null;
          }
          const bag = kind === "header" ? pkg.headers : pkg.footers;
          return bag?.get(rId) ?? null;
        },
        [],
      );

      const slots = useMemo<HfPartKey[]>(
        () => enumerateHfSlots(document),
        // Re-enumerate when the Maps themselves are swapped. Mutations to the
        // existing Map (e.g. external save) intentionally do NOT trigger
        // this — the persistent PM is the source of truth while loaded.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [document?.package.headers, document?.package.footers],
      );

      useEffect(() => {
        if (!hostRef.current) {
          return;
        }
        const host = hostRef.current;
        const want = new Map(slots.map((s) => [s.rId, s] as const));
        const have = mountedRef.current;

        for (const [rId, mounted] of have) {
          if (!want.has(rId)) {
            mounted.view.destroy();
            mounted.mountNode.remove();
            have.delete(rId);
            managersRef.current.delete(rId);
          }
        }

        for (const slot of slots) {
          if (have.has(slot.rId)) {
            continue;
          }
          const hf = resolveHf(slot.rId, slot.kind);
          if (!hf) {
            continue;
          }

          const mgr = new ExtensionManager(createStarterKit());
          mgr.buildSchema();
          mgr.initializeRuntime();
          managersRef.current.set(slot.rId, mgr);

          const node = host.ownerDocument.createElement("div");
          node.dataset["hfRId"] = slot.rId;
          node.dataset["hfKind"] = slot.kind;
          host.append(node);

          const state = buildInitialState(hf, styles, theme, mgr);
          const slotRId = slot.rId;
          const slotKind = slot.kind;
          const view: EditorView = new EditorView(node, {
            state,
            dispatchTransaction(tr) {
              const newState = view.state.apply(tr);
              view.updateState(newState);
              onTransactionRef.current?.(
                slotRId,
                slotKind,
                view,
                tr.docChanged,
                tr.selectionSet,
              );
            },
          });
          have.set(slot.rId, {
            rId: slot.rId,
            kind: slot.kind,
            view,
            mountNode: node,
          });
        }
        // `document` is intentionally excluded — slot enumeration flows via
        // `slots`, and `resolveHf` reads from the captured closure. Depending
        // on `document` directly causes a full remount on every body PM
        // transaction (each pushDocument returns a new identity), which
        // destroys IME state and selection.
      }, [slots, resolveHf, styles, theme]);

      // Tear everything down on unmount.
      useEffect(() => {
        const have = mountedRef.current;
        const mgrs = managersRef.current;
        return () => {
          for (const { view, mountNode } of have.values()) {
            view.destroy();
            mountNode.remove();
          }
          have.clear();
          mgrs.clear();
        };
      }, []);

      useImperativeHandle(
        ref,
        () => ({
          getView(rId: string): EditorView | null {
            return mountedRef.current.get(rId)?.view ?? null;
          },
          listSlots(): HfPartKey[] {
            return [...mountedRef.current.values()].map(({ rId, kind }) => ({
              rId,
              kind,
            }));
          },
        }),
        [],
      );

      return <div ref={hostRef} style={HOST_STYLES} />;
    },
  ),
);

HiddenHeaderFooterPMs.displayName = "HiddenHeaderFooterPMs";
