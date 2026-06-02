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
import { createDocumentStylesPlugin } from "../core/prosemirror/plugins/documentStyles";
import { schema } from "../core/prosemirror/schema";
import type {
  BlockContent,
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
  /**
   * Reference to the `HeaderFooter` object the view was built from. Used to
   * detect when a new document brings in a different HF for the same rId
   * (truly new doc load, or undo/redo reverting an HF edit) so the view's
   * state can be rebuilt from the new content. In-session in-place
   * mutations don't change this reference.
   */
  appliedHf: HeaderFooter;
  /**
   * Reference to the content array on `appliedHf` at the moment the
   * view was last synced. handleDispatchTransaction writes the latest
   * `proseDocToBlocks(state.doc)` here so the change-detection check
   * works even when the surrounding HF object is re-allocated by a
   * history snapshot (the array reference survives if the snapshot
   * spreads `...existing` without overriding content).
   */
  appliedContent: BlockContent[];
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
  // Header/footer paragraphs share the document's style table, so they get
  // the same style-aware behavior (e.g. Enter after a heading → body text).
  const styleResolverPlugin = createDocumentStylesPlugin(styles);
  return EditorState.create({
    doc: pmDoc,
    schema,
    plugins: [...mgr.getPlugins(), styleResolverPlugin],
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
          const hf = resolveHf(slot.rId, slot.kind);
          if (!hf) {
            continue;
          }
          const existing = have.get(slot.rId);
          if (existing) {
            // Same rId is still around. Decide whether the view needs to
            // adopt new content (truly new document, or undo/redo
            // restoring an earlier HF state) by comparing the active
            // HeaderFooter reference. handleDispatchTransaction keeps
            // appliedHf / appliedContent pointing at the same array
            // reference the in-place sync wrote, so an in-session
            // pushDocument that spreads `...existing` survives without
            // a state rebuild.
            if (
              existing.appliedHf === hf &&
              existing.appliedContent === hf.content
            ) {
              continue;
            }
            const mgr = managersRef.current.get(slot.rId);
            if (!mgr) {
              continue;
            }
            const newState = buildInitialState(hf, styles, theme, mgr);
            existing.view.updateState(newState);
            existing.appliedHf = hf;
            existing.appliedContent = hf.content;
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
              // INTENTIONALLY no in-place mutation of `appliedHf.content`.
              // Earlier revisions did `target.content = blocks` here to
              // keep `Document.package.headers/footers[rId].content`
              // current with each keystroke, but `appliedHf` is the
              // same HeaderFooter object referenced by every undo entry
              // in history that pre-dates this edit session — mutating
              // it corrupted those snapshots, so a document-undo after
              // closing HF mode couldn't restore the pre-edit content
              // (Codex #487 P1). The view's state.doc is now the only
              // source of truth while the chrome is open; the painter
              // already reads through `convertHeaderFooterPmDocToContent`
              // when a view exists, and `handleHeaderFooterSave` flushes
              // the latest blocks into a brand-new HeaderFooter object
              // in a brand-new Map on close, so history only ever sees
              // committed snapshots.
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
            appliedHf: hf,
            appliedContent: hf.content,
          });
        }
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
