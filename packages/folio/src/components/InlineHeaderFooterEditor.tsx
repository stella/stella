/**
 * InlineHeaderFooterEditor — UI chrome for HF editing.
 *
 * Before the HF editing unification, this component mounted its own visible
 * ProseMirror EditorView positioned over the painted HF area. The painter
 * underneath was hidden via `visibility: hidden` and the visible PM owned
 * editing. That model produced edit/non-edit geometry drift, field-insert
 * extra keystrokes, scroll-to-page-1 on cross-page HF edits, and imprecise
 * caret placement.
 *
 * Post-unification (eigenpal#611), the painter is the sole visible HF
 * renderer in both edit and non-edit modes; user input flows through the
 * persistent off-screen EditorView mounted by `HiddenHeaderFooterPMs`.
 * This component is now just chrome: a positioned label, an options menu
 * (Insert PAGE / NUMPAGES / Remove / Close), and the separator bar.
 *
 * The ref still exposes `getView` / `focus` / `undo` / `redo` so existing
 * callers (`useHeaderFooterEditor`, toolbar wiring) keep working — those
 * methods now delegate to the active HF PM via `getActiveView`.
 */

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { CSSProperties, Ref } from "react";

import { redo, undo } from "prosemirror-history";
import type { EditorView } from "prosemirror-view";

import { schema } from "../core/prosemirror";
import "prosemirror-view/style/prosemirror.css";

// ============================================================================
// TYPES
// ============================================================================

export type InlineHeaderFooterEditorProps = {
  /** Whether editing header or footer */
  position: "header" | "footer";
  /** The DOM element to overlay (the .layout-page-header / .layout-page-footer) */
  targetElement: HTMLElement;
  /** The positioning parent element (the div wrapping PagedEditor) */
  parentElement: HTMLElement;
  /**
   * Returns the persistent hidden HF EditorView the user is currently
   * editing. The chrome's ref methods (`getView`, `focus`, `undo`, `redo`)
   * and the options menu's field inserts all route through this.
   */
  getActiveView: () => EditorView | null;
  /** Callback when editing is cancelled (Escape / Close button) */
  onClose: () => void;
  /** Callback to remove the header/footer entirely */
  onRemove?: () => void;
};

export type InlineHeaderFooterEditorRef = {
  /** Get the active HF PM EditorView (the persistent hidden one). */
  getView(): EditorView | null;
  /** Focus the active HF PM. */
  focus(): void;
  /** Undo on the active HF PM. */
  undo(): boolean;
  /** Redo on the active HF PM. */
  redo(): boolean;
};

// ============================================================================
// STYLES
// ============================================================================

const separatorBarStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "2px 0",
  fontSize: 11,
  color: "var(--doc-link)",
  userSelect: "none",
};

const labelStyle: CSSProperties = {
  fontWeight: 500,
  letterSpacing: 0.3,
};

// ============================================================================
// COMPONENT
// ============================================================================

export function InlineHeaderFooterEditor({
  ref,
  position,
  targetElement,
  parentElement,
  getActiveView,
  onClose,
  onRemove,
}: InlineHeaderFooterEditorProps & {
  ref?: Ref<InlineHeaderFooterEditorRef>;
}) {
  const [showOptions, setShowOptions] = useState(false);
  const optionsRef = useRef<HTMLDivElement>(null);

  const [overlayPos, setOverlayPos] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  useEffect(() => {
    const computePosition = () => {
      const parentRect = parentElement.getBoundingClientRect();
      const targetRect = targetElement.getBoundingClientRect();
      setOverlayPos({
        top: targetRect.top - parentRect.top + parentElement.scrollTop,
        left: targetRect.left - parentRect.left + parentElement.scrollLeft,
        width: targetRect.width,
      });
    };
    computePosition();

    const scrollParent =
      parentElement.closest('[style*="overflow"]') || parentElement;
    scrollParent.addEventListener("scroll", computePosition);
    window.addEventListener("resize", computePosition);
    return () => {
      scrollParent.removeEventListener("scroll", computePosition);
      window.removeEventListener("resize", computePosition);
    };
  }, [targetElement, parentElement]);

  // Focus the persistent HF PM when the chrome mounts so typing starts
  // immediately after double-click. Mirrors what the old visible-PM mount
  // did via requestAnimationFrame + view.focus().
  useEffect(() => {
    const view = getActiveView();
    if (view) {
      // Defer one frame so the painted DOM is in place before focus.
      const id = requestAnimationFrame(() => {
        view.focus();
      });
      return () => cancelAnimationFrame(id);
    }
    return undefined;
    // getActiveView is intentionally not in deps — it's a stable function
    // by design from the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        handleClose();
      }
    }
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [handleClose]);

  useEffect(() => {
    if (!showOptions) {
      return;
    }
    function handleClick(e: MouseEvent) {
      if (
        optionsRef.current &&
        !optionsRef.current.contains(e.target as Node)
      ) {
        setShowOptions(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showOptions]);

  useImperativeHandle(ref, () => ({
    getView: () => getActiveView(),
    focus: () => getActiveView()?.focus(),
    undo: () => {
      const view = getActiveView();
      if (!view) {
        return false;
      }
      return undo(view.state, view.dispatch);
    },
    redo: () => {
      const view = getActiveView();
      if (!view) {
        return false;
      }
      return redo(view.state, view.dispatch);
    },
  }));

  const label = position === "header" ? "Header" : "Footer";

  if (!overlayPos) {
    return null;
  }

  const containerStyle: CSSProperties = {
    position: "absolute",
    top: overlayPos.top,
    left: overlayPos.left,
    width: overlayPos.width,
    zIndex: 10,
    // No pointer events on the chrome container itself — the painted HF
    // beneath must receive clicks so the pointer pipeline routes them to
    // the persistent HF PM. Individual chrome buttons opt back in.
    pointerEvents: "none",
  };

  return (
    <div
      role="presentation"
      className="hf-inline-editor"
      style={containerStyle}
    >
      {position === "footer" && (
        <div
          className="hf-separator-bar"
          style={{ ...separatorBarStyle, pointerEvents: "auto" }}
        >
          <span style={labelStyle}>{label}</span>
          <OptionsMenu
            label={label}
            showOptions={showOptions}
            setShowOptions={setShowOptions}
            optionsRef={optionsRef}
            onRemove={onRemove}
            onClose={handleClose}
            getActiveView={getActiveView}
          />
        </div>
      )}

      {position === "header" && (
        <div
          className="hf-separator-bar"
          style={{ ...separatorBarStyle, pointerEvents: "auto" }}
        >
          <span style={labelStyle}>{label}</span>
          <OptionsMenu
            label={label}
            showOptions={showOptions}
            setShowOptions={setShowOptions}
            optionsRef={optionsRef}
            onRemove={onRemove}
            onClose={handleClose}
            getActiveView={getActiveView}
          />
        </div>
      )}
    </div>
  );
}

// ============================================================================
// OPTIONS MENU SUB-COMPONENT
// ============================================================================

function OptionsMenu({
  label,
  showOptions,
  setShowOptions,
  optionsRef,
  onRemove,
  onClose,
  getActiveView,
}: {
  label: string;
  showOptions: boolean;
  setShowOptions: (v: boolean | ((prev: boolean) => boolean)) => void;
  optionsRef: React.RefObject<HTMLDivElement | null>;
  onRemove?: (() => void) | undefined;
  onClose: () => void;
  getActiveView: () => EditorView | null;
}) {
  const insertField = (fieldType: "PAGE" | "NUMPAGES") => {
    const view = getActiveView();
    if (!view) {
      return;
    }
    const { $from, from } = view.state.selection;
    const marks = view.state.storedMarks || $from.marks();
    const node = schema.nodes["field"]!.create({
      fieldType,
      instruction: ` ${fieldType} \\* MERGEFORMAT `,
      fieldKind: "simple",
      dirty: true,
    });
    const tr = view.state.tr.insert(from, node.mark(marks));
    view.dispatch(tr);
    view.focus();
  };

  return (
    <div style={{ position: "relative" }} ref={optionsRef}>
      <button
        type="button"
        className="hf-options-button"
        onClick={(e) => {
          e.stopPropagation();
          setShowOptions((prev) => !prev);
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        Options ▾
      </button>
      {showOptions && (
        <div className="hf-options-dropdown">
          <button
            type="button"
            className="hf-options-item"
            onClick={() => {
              setShowOptions(false);
              insertField("PAGE");
            }}
          >
            Insert current page number
          </button>
          <button
            type="button"
            className="hf-options-item"
            onClick={() => {
              setShowOptions(false);
              insertField("NUMPAGES");
            }}
          >
            Insert total page count
          </button>
          <div className="hf-options-divider" />
          {onRemove && (
            <button
              type="button"
              className="hf-options-item"
              onClick={() => {
                setShowOptions(false);
                onRemove();
              }}
            >
              Remove {label.toLowerCase()}
            </button>
          )}
          <button
            type="button"
            className="hf-options-item"
            onClick={() => {
              setShowOptions(false);
              onClose();
            }}
          >
            Close {label.toLowerCase()} editing
          </button>
        </div>
      )}
    </div>
  );
}
