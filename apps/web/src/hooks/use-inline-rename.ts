import { useRef, useState } from "react";

/**
 * Inline rename state machine shared by toolbars, sidebars, kanban
 * cards, breadcrumbs, and chat tab headers. The hook owns the
 * view/edit transition, the draft buffer, and an optional inline
 * error string; callers wire in domain rules via `validate` and
 * `onCommit` (which receives a `setError` helper for server-side
 * validation failures such as 409 conflicts).
 *
 * Commit semantics:
 *  - Empty trimmed value: silently cancel (matches every existing
 *    site, none of which create empty names).
 *  - Trimmed value equals current `initial`: silently cancel.
 *  - `validate` returns a string: stay in edit mode, surface the
 *    string as `state.error`.
 *  - `onCommit` may return a promise; while it is in flight the
 *    state machine stays in `view` mode unless `setError` is
 *    called from inside `onCommit`, in which case the editor
 *    re-enters edit mode with the rejected draft (server-side
 *    validation rollback).
 */
type InlineRenameState =
  | { mode: "view" }
  | { mode: "edit"; draft: string; error?: string };

type CommitHelpers = {
  /**
   * Re-enters edit mode with the rejected draft and surfaces an
   * inline error. Use this from `onCommit` when a server-side
   * validation failure (e.g., 409 conflict) needs to be displayed
   * next to the input rather than thrown as a toast.
   */
  setError: (message: string) => void;
};

type UseInlineRenameOptions = {
  /** Current persisted value; used as the seed for `draft` and to detect no-op commits. */
  initial: string;
  /**
   * Invoked with the trimmed draft once it has passed `validate`
   * and is not a no-op. May be async; rejections surface to the
   * caller (typical pattern: rollback inside `onError`).
   */
  onCommit: (value: string, helpers: CommitHelpers) => void | Promise<void>;
  /**
   * Synchronous client-side validation. Returns an error message
   * to display inline, or `null` to allow the commit to proceed.
   */
  validate?: (value: string) => string | null;
};

type UseInlineRenameReturn = {
  state: InlineRenameState;
  startEditing: (override?: string) => void;
  setDraft: (draft: string) => void;
  commit: () => Promise<void>;
  cancel: () => void;
};

export const useInlineRename = ({
  initial,
  onCommit,
  validate,
}: UseInlineRenameOptions): UseInlineRenameReturn => {
  const [state, setState] = useState<InlineRenameState>({ mode: "view" });
  // `cancelled` lets the caller short-circuit an in-flight blur:
  // pressing Escape blurs the input synchronously, but the blur's
  // `commit()` reads `state` from a stale closure. The ref flips
  // immediately so `commit()` can see the cancel even before
  // React commits the state transition.
  const cancelledRef = useRef(false);

  const startEditing = (override?: string) => {
    cancelledRef.current = false;
    setState({ mode: "edit", draft: override ?? initial });
  };

  const setDraft = (draft: string) => {
    // Typing clears any stale error so the user can retry inline
    // without first having to dismiss the previous server message.
    setState((prev) => (prev.mode === "edit" ? { mode: "edit", draft } : prev));
  };

  const cancel = () => {
    cancelledRef.current = true;
    setState({ mode: "view" });
  };

  const commit = async () => {
    if (state.mode !== "edit" || cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    const trimmed = state.draft.trim();
    if (!trimmed || trimmed === initial) {
      setState({ mode: "view" });
      return;
    }
    const validationError = validate?.(trimmed) ?? null;
    if (validationError !== null) {
      setState({ mode: "edit", draft: state.draft, error: validationError });
      return;
    }
    // Optimistically exit edit mode; if `onCommit` invokes
    // `setError`, we flip back to edit with the rejected draft so
    // server-side validation feels inline. Hold the captured value
    // in a single-cell ref so the closure can write through it
    // without TS narrowing the outer binding to its initial null.
    const errorBox: { current: string | null } = { current: null };
    setState({ mode: "view" });
    await onCommit(trimmed, {
      setError: (message: string) => {
        errorBox.current = message;
      },
    });
    if (errorBox.current !== null) {
      setState({ mode: "edit", draft: trimmed, error: errorBox.current });
    }
  };

  return { state, startEditing, setDraft, commit, cancel };
};
