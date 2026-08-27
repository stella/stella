/**
 * ReviewBar — floating bottom-center pill over the DOCX editor that
 * drives a keyboard-first review loop through the AI's pending
 * suggestions. Shares the review-store (and {@link useReviewActions})
 * with the inspector's document-review facet, so stepping / accepting /
 * rejecting here and there can never disagree.
 *
 * Keyboard (active while the bar is visible and focus is in the editor
 * or on the bar, never in the chat composer or a form field). The bindings
 * below are the DEFAULTS; each is a registry entry (`acceptSuggestion`,
 * `rejectSuggestion`, `previousSuggestion`, `nextSuggestion`) that the user
 * can rebind, so the handler matches the effective binding rather than a
 * hardcoded chord:
 *   Alt+Enter        accept the focused suggestion and advance
 *   Alt+Shift+Enter  reject the focused suggestion and advance
 *   Alt+ArrowUp      focus the previous pending suggestion
 *   Alt+ArrowDown    focus the next pending suggestion
 *
 * Alt (not Cmd/Ctrl) is the DEFAULT because folio binds Mod+Enter to a document-level
 * page break in the capture phase and Mod+Backspace to delete-backward;
 * Alt+Enter, Alt+Shift+Enter and Alt+ArrowUp/Down are all unbound.
 * Reject deliberately avoids Alt+Backspace: that IS macOS delete-word
 * inside the editor, so claiming it would destructively reject a
 * suggestion when a user only meant to delete a word mid-review.
 * Alt+Shift+Enter does not collide with folio's hard break (plain
 * Shift+Enter, no Alt). The listener still runs in the capture phase so
 * it wins over any editor default before the editor can act.
 */

import { useRef } from "react";
import type { RefObject } from "react";

import { matchesKeyboardEvent } from "@tanstack/react-hotkeys";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import type { DocxEditorRef } from "@stll/folio-react";
import { Button } from "@stll/ui/button";
import { ReviewDecisionActions } from "@stll/ui/review-decision-actions";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { cn } from "@stll/ui/utils";

import { AcceptAllButton } from "@/components/ai-suggestions/accept-all-button";
import { DOCKED_COMPOSER_WIDTH_CLASS } from "@/components/ai-suggestions/composer-geometry";
import {
  getReviewBarAction,
  getReviewBarFocusTarget,
  getReviewBarPosition,
} from "@/components/ai-suggestions/review-bar.logic";
import {
  getReviewFocusedId,
  useReviewStore,
} from "@/components/ai-suggestions/review-store";
import type { ReviewSuggestion } from "@/components/ai-suggestions/review-store";
import { useReviewActions } from "@/components/ai-suggestions/use-review-actions";
import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { useHydrationSafeHotkeyPlatform } from "@/hooks/use-hydration-safe-hotkey-platform";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { detached } from "@/lib/detached";
import { formatHotkeyForPlatform } from "@/lib/hotkeys";
import { useEffectiveHotkey } from "@/lib/use-effective-shortcuts";

const EMPTY_SUGGESTIONS: readonly ReviewSuggestion[] = [];

const isPending = (item: ReviewSuggestion): boolean =>
  item.status === "pending";

type ReviewBarProps = {
  entityId: string;
  persistence: { type: "local" } | { type: "workspace"; workspaceId: string };
  docxEditorRef: RefObject<DocxEditorRef | null>;
  /** Whether the editor currently accepts edit operations. */
  docxEditable: boolean;
  requestDocxEditMode?: (() => boolean | Promise<boolean>) | undefined;
};

export const ReviewBar = ({
  entityId,
  persistence,
  docxEditorRef,
  docxEditable,
  requestDocxEditMode,
}: ReviewBarProps) => {
  const t = useTranslations();
  const hotkeyPlatform = useHydrationSafeHotkeyPlatform();
  // Effective (user-rebindable) bindings for the four review shortcuts. The
  // capture-phase handler below matches against these, and the tooltips render
  // them, so a rebind changes both behavior and the discoverable hint. These
  // are keyboard tokens (⌥↵ / Alt+Enter), not translatable prose.
  const acceptHotkey = useEffectiveHotkey("acceptSuggestion");
  const rejectHotkey = useEffectiveHotkey("rejectSuggestion");
  const prevHotkey = useEffectiveHotkey("previousSuggestion");
  const nextHotkey = useEffectiveHotkey("nextSuggestion");
  // `?? EMPTY_SUGGESTIONS` shares one module-level array for no-session
  // reads so useSyncExternalStore doesn't loop on a fresh `[]` each call.
  const suggestions =
    useReviewStore((state) => state.sessions[entityId]) ?? EMPTY_SUGGESTIONS;
  const focusedId = useReviewStore((state) =>
    getReviewFocusedId(state, entityId),
  );
  const setFocusedId = useReviewStore((state) => state.setFocusedId);
  const {
    applyMode,
    setApplyMode,
    acceptOne,
    rejectOne,
    acceptMany,
    revertOne,
    navigateTo,
  } = useReviewActions({
    entityId,
    persistence,
    docxEditorRef,
    docxEditable,
    requestDocxEditMode,
  });

  const pendingItems = suggestions.filter(isPending);
  const { activeIndex, current, total } = getReviewBarPosition(
    suggestions,
    focusedId,
  );
  const activeItem = suggestions.at(activeIndex);
  const activeAction =
    activeItem === undefined ? "busy" : getReviewBarAction(activeItem);

  // The first proposed edit must be visible in the document as soon as the
  // review controls appear. Without this, the bar says "1 / n" but Folio has
  // no focused id, so it renders only generic underlines rather than the
  // exact struck-through/replacement pair the reviewer is about to resolve.
  const focusTargetId = getReviewBarFocusTarget(suggestions, focusedId);
  useExternalSyncEffect(() => {
    if (focusTargetId !== null) {
      setFocusedId(entityId, focusTargetId);
    }
  }, [entityId, focusTargetId, setFocusedId]);

  const focusAt = useLatestCallback((index: number) => {
    const item = suggestions.at(index);
    if (item) {
      navigateTo(item);
    }
  });

  const goPrev = useLatestCallback(() => {
    focusAt(activeIndex <= 0 ? 0 : activeIndex - 1);
  });

  const goNext = useLatestCallback(() => {
    focusAt(Math.min(total - 1, activeIndex + 1));
  });

  // Guards against a second acceptance starting while the current one is
  // still applying (rapid Alt+Enter / double-click), which would otherwise
  // apply the same stale suggestion twice before the store settles.
  const acceptBusyRef = useRef(false);
  const acceptAndAdvance = useLatestCallback(async () => {
    if (acceptBusyRef.current) {
      return;
    }
    const target = suggestions.at(activeIndex);
    if (target?.status !== "pending") {
      return;
    }
    // Capture the neighbour BEFORE accepting: after accept the target
    // leaves the pending queue, so the "next" to park on is the item that
    // followed it (or the one before, at the end of the list).
    const next = suggestions.at(activeIndex + 1);
    acceptBusyRef.current = true;
    // `.finally` (not try/finally): a try-without-catch trips the React
    // Compiler's HIR lowering and bails the component out of optimization.
    await acceptOne(target).finally(() => {
      acceptBusyRef.current = false;
    });
    if (next && next.id !== target.id) {
      navigateTo(next);
    }
  });

  const rejectAndAdvance = useLatestCallback(() => {
    const target = suggestions.at(activeIndex);
    if (target?.status !== "pending") {
      return;
    }
    const next = suggestions.at(activeIndex + 1);
    rejectOne(target);
    if (next && next.id !== target.id) {
      navigateTo(next);
    }
  });

  const revertActive = useLatestCallback(() => {
    const target = suggestions.at(activeIndex);
    if (target === undefined || getReviewBarAction(target) !== "revert") {
      return;
    }
    revertOne(target);
  });

  const handleKeyDown = useLatestCallback((event: KeyboardEvent) => {
    if (total === 0 || !shouldHandleReviewShortcut()) {
      return;
    }
    // Match against the effective bindings. `matchesKeyboardEvent` compares
    // modifiers exactly, so accept (default Alt+Enter) and reject (default
    // Alt+Shift+Enter) stay distinct even though they share the Enter key, and
    // a stray Shift can never turn one into the other.
    if (matchesKeyboardEvent(event, rejectHotkey)) {
      if (activeAction !== "resolve") {
        return;
      }
      claimShortcut(event);
      rejectAndAdvance();
      return;
    }
    if (matchesKeyboardEvent(event, acceptHotkey)) {
      if (activeAction !== "resolve") {
        return;
      }
      claimShortcut(event);
      detached(acceptAndAdvance(), "review-bar.accept-and-advance");
      return;
    }
    if (matchesKeyboardEvent(event, prevHotkey)) {
      claimShortcut(event);
      goPrev();
      return;
    }
    if (matchesKeyboardEvent(event, nextHotkey)) {
      claimShortcut(event);
      goNext();
    }
  });

  // Capture-phase document listener so the shortcuts win over any editor
  // default before the editor can act. Registered once; `handleKeyDown`
  // reads the latest state on each call.
  useMountEffect(() => {
    document.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      document.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  });

  if (total === 0) {
    return null;
  }

  return (
    <div
      aria-label={t("docxReview.barLabel")}
      data-docx-review-bar=""
      className={cn(
        "text-popover-foreground border-foreground/15 pointer-events-auto absolute start-1/2 bottom-24 z-50 flex -translate-x-1/2 items-center gap-1 rounded-2xl border py-0.5 ps-1.5 pe-1",
        DOCKED_COMPOSER_WIDTH_CLASS,
        "bg-(--doc-float-surface) [--doc-float-surface:var(--color-white)] dark:[--doc-float-surface:var(--popover)]",
        "shadow-[0_0_0_1px_rgb(0_0_0/0.02),0_1px_2px_rgb(0_0_0/0.03),0_8px_20px_rgb(0_0_0/0.05)]",
        "animate-in fade-in-0 slide-in-from-bottom-1",
      )}
      role="toolbar"
    >
      {activeItem !== undefined && (
        <button
          className="text-foreground hover:bg-muted focus-visible:ring-ring min-w-0 flex-1 truncate rounded-md px-1.5 text-start text-xs font-medium transition-colors outline-none focus-visible:ring-2 @max-[42rem]/file-viewer:hidden"
          onClick={() => navigateTo(activeItem)}
          title={activeItem.summary}
          type="button"
        >
          {activeItem.summary}
        </button>
      )}
      <span className="text-muted-foreground min-w-14 px-1 text-center text-xs font-medium tabular-nums">
        {t("common.stepProgress", {
          current: String(current),
          total: String(total),
        })}
      </span>
      <Button
        aria-label={t("common.previous")}
        disabled={activeIndex <= 0}
        onClick={goPrev}
        size="icon-sm"
        tooltip={`${t("common.previous")} · ${formatHotkeyForPlatform(
          prevHotkey,
          hotkeyPlatform,
        )}`}
        variant="ghost"
      >
        <ChevronUpIcon className="size-4" />
      </Button>
      <Button
        aria-label={t("common.next")}
        disabled={activeIndex >= suggestions.length - 1}
        onClick={goNext}
        size="icon-sm"
        tooltip={`${t("common.next")} · ${formatHotkeyForPlatform(
          nextHotkey,
          hotkeyPlatform,
        )}`}
        variant="ghost"
      >
        <ChevronDownIcon className="size-4" />
      </Button>
      <span aria-hidden="true" className="bg-border mx-0.5 h-5 w-px" />
      {activeAction === "revert" && (
        <ReviewDecisionActions
          onRevert={revertActive}
          // Unlike accept/reject, revert keeps its label at every width: it is
          // the only action in this state and a ghost button with a hidden
          // label would collapse to nothing.
          revertLabel={t("docxReview.revert")}
          size="xs"
          state="accepted"
        />
      )}
      {activeAction !== "revert" && activeAction !== "resolved" && (
        <ReviewDecisionActions
          acceptLabel={
            <span className="@max-[80rem]/file-viewer:hidden">
              {t("common.accept")}
            </span>
          }
          acceptTooltip={`${t("common.accept")} · ${formatHotkeyForPlatform(
            acceptHotkey,
            hotkeyPlatform,
          )}`}
          onAccept={() => {
            detached(acceptAndAdvance(), "review-bar.accept-and-advance");
          }}
          onReject={rejectAndAdvance}
          rejectLabel={
            <span className="@max-[80rem]/file-viewer:hidden">
              {t("docxReview.reject")}
            </span>
          }
          rejectTooltip={`${t("docxReview.reject")} · ${formatHotkeyForPlatform(
            rejectHotkey,
            hotkeyPlatform,
          )}`}
          size="xs"
          state={activeAction === "busy" ? "applying" : "pending"}
        />
      )}
      {pendingItems.length > 0 && (
        <AcceptAllButton
          className="h-7 px-2.5 text-xs"
          onAcceptAll={acceptMany}
          pendingItems={pendingItems}
          size="sm"
          variant="ghost"
        >
          <span className="@max-[80rem]/file-viewer:hidden">
            {t("docxReview.acceptAll")}
          </span>
        </AcceptAllButton>
      )}
      <span aria-hidden="true" className="bg-border mx-0.5 h-5 w-px" />
      <Select
        onValueChange={(value) => {
          if (value === "tracked-changes" || value === "direct") {
            setApplyMode(value);
          }
        }}
        value={applyMode}
      >
        <SelectTrigger
          aria-label={t("docxReview.applyAs")}
          className="hover:bg-muted h-7 w-auto max-w-64 min-w-0 justify-between gap-1 rounded-full border-0 bg-transparent px-2 text-xs font-medium @max-[36rem]/file-viewer:max-w-36"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="tracked-changes">
            {t("docxReview.applyTracked")}
          </SelectItem>
          <SelectItem value="direct">{t("docxReview.applyDirect")}</SelectItem>
        </SelectPopup>
      </Select>
    </div>
  );
};

const claimShortcut = (event: KeyboardEvent) => {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
};

/**
 * Whether a review keyboard shortcut should act on the current focus.
 * Fires while the document editor has focus (the Word model) or focus
 * is on the bar itself; never while typing in the chat composer or any
 * other text input / rich editor.
 */
const shouldHandleReviewShortcut = (): boolean => {
  const el = document.activeElement;
  // No focused element (or focus on the body): the bar is the only relevant
  // surface, so claim the shortcut.
  if (!(el instanceof HTMLElement) || el === document.body) {
    return true;
  }
  // Positive scoping (per review): only fire when focus is inside the DOCX
  // editor — the Word model, where shortcuts must work while typing in the
  // document — or on the review bar's own controls. Focus anywhere else
  // (chat composer, sidebar, dialogs, nav, unrelated buttons/links) is left
  // to that surface.
  return (
    el.closest(".folio-docx-preview") !== null ||
    el.closest("[data-docx-review-bar]") !== null
  );
};
