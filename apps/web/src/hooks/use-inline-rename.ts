import { useRef, useState } from "react";

import { useLatestCallback, useMountEffect } from "@stll/ui/effects";

import { detached } from "@/lib/detached";

/**
 * Inline rename state machine shared by toolbars, sidebars, kanban
 * cards, breadcrumbs, and chat tab headers. The hook owns the
 * view/edit transition, the draft buffer, and an optional inline
 * error string; callers wire in domain rules via `validate` and
 * `onCommit` (which receives a `setError` helper for server-side
 * validation failures such as 409 conflicts).
 *
 * Commit semantics:
 *  - Trimmed value equals current `initial`: silently cancel.
 *  - `validate` runs next and may return a string for any value
 *    (including the empty string) to keep the editor open with
 *    `state.error` set; returning `null` lets the commit proceed.
 *  - Without `validate`, an empty trimmed value silently cancels
 *    (default for callers that never create empty names). Callers
 *    that need to react to empty input (e.g., emit a toast) should
 *    define `validate` and let it return `null` so the empty
 *    string is forwarded to `onCommit`.
 *  - `onCommit` is invoked with the trimmed draft. The hook
 *    optimistically transitions to `view` before calling it; if
 *    `setError` runs (either synchronously, awaited, or later
 *    from a fire-and-forget `mutate({ onError })` callback) the
 *    editor re-enters edit mode with the rejected draft so
 *    server-side validation feels inline.
 */
type InlineRenameState =
  { mode: "view" } | { mode: "edit"; draft: string; error?: string };

type CommitPlan =
  | { kind: "skip" }
  | { kind: "close" }
  | { kind: "invalid"; draft: string; error: string }
  | { kind: "send"; value: string };

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
  /** Persist an uncancelled draft when its owning editor leaves the page. */
  commitOnUnmount?: boolean;
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
  commitOnUnmount = false,
}: UseInlineRenameOptions): UseInlineRenameReturn => {
  const [state, setState] = useState<InlineRenameState>({ mode: "view" });
  // `cancelled` lets the caller short-circuit an in-flight blur:
  // pressing Escape blurs the input synchronously, but the blur's
  // `commit()` reads `state` from a stale closure. The ref flips
  // immediately so `commit()` can see the cancel even before
  // React commits the state transition.
  const cancelledRef = useRef(false);
  const committedRef = useRef(false);
  // `generationRef` invalidates `setError` callbacks from a
  // previous commit cycle. Without it, a stale fire-and-forget
  // `onError` could clobber a fresh edit the user has already
  // started or cancelled. Bumped on every commit, cancel, and
  // explicit `startEditing`.
  const generationRef = useRef(0);

  const startEditing = (override?: string) => {
    cancelledRef.current = false;
    committedRef.current = false;
    generationRef.current += 1;
    setState({ mode: "edit", draft: override ?? initial });
  };

  const setDraft = (draft: string) => {
    committedRef.current = false;
    // Typing clears any stale error so the user can retry inline
    // without first having to dismiss the previous server message.
    setState((prev) => (prev.mode === "edit" ? { mode: "edit", draft } : prev));
  };

  const cancel = () => {
    cancelledRef.current = true;
    generationRef.current += 1;
    setState({ mode: "view" });
  };

  // What committing the current draft does, decided without touching state.
  const planCommit = (): CommitPlan => {
    if (state.mode !== "edit" || cancelledRef.current || committedRef.current) {
      return { kind: "skip" };
    }
    const trimmed = state.draft.trim();
    if (trimmed === initial) {
      return { kind: "close" };
    }
    // Run client-side validation before the empty-string
    // short-circuit so callers that care about required fields
    // (e.g., `validate: v => v ? null : "name required"`) can opt
    // into "stay in edit mode with an inline error" semantics.
    const validationError = validate?.(trimmed) ?? null;
    if (validationError !== null) {
      return { kind: "invalid", draft: state.draft, error: validationError };
    }
    if (!trimmed && validate === undefined) {
      // No validator opted in; preserve the default "empty draft
      // silently cancels" behaviour matching every existing site.
      // Callers that supply `validate` (even if it returns `null`)
      // are saying "I will handle the empty case myself" so we
      // forward the empty string through to `onCommit`.
      return { kind: "close" };
    }
    return { kind: "send", value: trimmed };
  };

  // Hands the value to `onCommit`. `setError` updates state directly so
  // it works for both awaited promises and fire-and-forget patterns such
  // as TanStack Query's `.mutate({ onError })`, whose callback may run
  // after `commit()` has already returned.
  const send = async (value: string) => {
    generationRef.current += 1;
    const generation = generationRef.current;
    committedRef.current = true;
    const result = onCommit(value, {
      setError: (message: string) => {
        // Ignore stale callbacks from a previous edit cycle the
        // user has already moved past (cancelled, started over,
        // or kicked off another commit).
        if (generationRef.current !== generation) {
          return;
        }
        committedRef.current = false;
        setState({ mode: "edit", draft: value, error: message });
      },
    });
    if (result instanceof Promise) {
      await result;
    }
  };

  const commit = async () => {
    const plan = planCommit();
    switch (plan.kind) {
      case "skip": {
        cancelledRef.current = false;
        return;
      }
      case "close": {
        setState({ mode: "view" });
        return;
      }
      case "invalid": {
        setState({ mode: "edit", draft: plan.draft, error: plan.error });
        return;
      }
      case "send": {
        // Optimistically exit edit mode; if `onCommit` invokes
        // `setError` we flip straight back to edit with the rejected
        // draft.
        setState({ mode: "view" });
        await send(plan.value);
        return;
      }
    }
  };

  // An editor that leaves the page has no state left to show: only a
  // draft that a commit would send goes out.
  const flush = useLatestCallback(() => {
    if (!commitOnUnmount) {
      return;
    }
    const plan = planCommit();
    if (plan.kind === "send") {
      detached(send(plan.value), "inline-rename.unmount");
    }
  });
  useMountEffect(() => () => flush());

  return { state, startEditing, setDraft, commit, cancel };
};
