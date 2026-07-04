/**
 * Docked AI-chat composer primitives.
 *
 * The shared building blocks every chat surface mounts: the docked
 * `PromptBar` (rich composer + preset chips + attachment tray + the
 * send/stop/retry action), its `DockedComposer` geometry owner, the
 * floating glass `ChatThreadCard`, the suggestion stepper, and the
 * `SuggestionCard` used to render an edit
 * suggestion. Surfaces (the file-chat overlay, Template Studio, the
 * inspector chat tab) own their own thread state and wire these
 * together; this module owns only the presentation and geometry so the
 * surfaces can never drift.
 */

import "@/components/chat-editor.css";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ComponentProps,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  RefObject,
} from "react";

import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  LoaderCircleIcon,
  UserIcon,
  WandSparklesIcon,
} from "lucide-react";
import type { EditorView } from "prosemirror-view";
import { useFormatter, useTranslations } from "use-intl";

import { scrollFolioPositionIntoView } from "@stll/folio-react";
import type {
  AISuggestion,
  AISuggestionPreset,
  AISuggestionSeverity,
} from "@stll/folio-react";
import { Button } from "@stll/ui/components/button";
import { DirectionalIcon } from "@stll/ui/components/directional-icon";
import {
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "@stll/ui/components/tooltip";
import { cn } from "@stll/ui/lib/utils";

import { useChatComposerWiring } from "@/components/chat-editor-provider";
import type {
  ChatEditorController,
  ChatInputDraft,
} from "@/components/chat-editor-provider";
import {
  ChatComposerActionButton,
  resolveChatComposerAction,
} from "@/components/chat/chat-composer-action-button";
import { ChatDraftAttachmentChips } from "@/components/chat/chat-draft-attachment-chips";
import { ComposerPlusMenu } from "@/components/chat/composer-plus-menu";
import { ComposerVeil } from "@/components/chat/composer-veil";
import { PromptEditorContent } from "@/components/prompt-editor";
import { usePulse } from "@/hooks/use-pulse";
import type { TranslationKey } from "@/i18n/types";
import { isValueTypeKind, VALUE_TYPE_META } from "@/lib/value-types";

import type { FileAIChatStatus } from "./types";

const SEVERITY_DOT_CLASS: Record<AISuggestionSeverity, string> = {
  substantive: "bg-destructive",
  style: "bg-foreground/55",
  typo: "bg-muted-foreground",
};

const SEVERITY_LABEL_KEYS = {
  substantive: "chat.suggestionSeverity.substantive",
  style: "chat.suggestionSeverity.style",
  typo: "chat.suggestionSeverity.typo",
} as const satisfies Record<AISuggestionSeverity, TranslationKey>;

/**
 * Visual layout mode consumed by `PromptBar`.
 *
 * The bar is docked identically in both modes (`DockedComposer` owns
 * its geometry); `layout` only gates surface features on the bar:
 *
 * - `floating` (default): the bar offers preset chips + the pending-
 *   suggestion badge, and the surface floats a `ChatThreadCard` over a
 *   file viewer. Used by the file-overlay and Template Studio chats.
 * - `standalone`: no preset chips or badge; the surface renders its own
 *   always-visible transcript above the bar. Used by the sidepeek Chat
 *   tab where there's no doc behind.
 */
type FileAIChatLayout = "floating" | "standalone";

// ===========================================================================
// View helpers
// ===========================================================================

/**
 * Scroll the document so the given PM position is centered in view.
 *
 * Folio's paged editor keeps its editing PM view hidden off-screen;
 * `coordsAtPos` on that view yields coordinates of the hidden mirror,
 * not the visible pages — scrolling by them moves a near-constant step
 * per call instead of jumping to the target. Prefer the paged-layout
 * scroll (anchors on the painted pages, page shells under
 * virtualization); fall back to coordinate math only when no paged
 * layout is mounted around the view.
 */
export function scrollEditorToPos(view: EditorView, pos: number): void {
  if (scrollFolioPositionIntoView(view, pos)) {
    return;
  }
  const scrollContainer = view.dom.closest("[data-folio-scroll]");
  if (scrollContainer === null) {
    return;
  }
  const coords = view.coordsAtPos(pos);
  const rect = scrollContainer.getBoundingClientRect();
  const targetTop = coords.top - rect.top + scrollContainer.scrollTop;
  scrollContainer.scrollTo({
    top: targetTop - rect.height / 3,
    behavior: "smooth",
  });
}

// ===========================================================================
// Prompt bar
// ===========================================================================

/** Document scope a preset send applies to. */
export type PromptBarPresetScope = "selection" | "document";

/**
 * Opt-in scope step for selected presets. When `appliesTo` matches a
 * clicked chip, the preset bypasses the plain `onSubmit` path and
 * goes through `onSubmit` here with an explicit scope: if
 * `shouldAskForScope()` is true (the editor has a live selection)
 * the chip row swaps to a tiny inline two-option chooser first;
 * otherwise the preset submits with the whole-document scope
 * immediately.
 */
type PromptBarPresetScopeChooser = {
  appliesTo: (preset: AISuggestionPreset) => boolean;
  shouldAskForScope: () => boolean;
  question: string;
  selectionLabel: string;
  documentLabel: string;
  onSubmit: (preset: AISuggestionPreset, scope: PromptBarPresetScope) => void;
};

type PromptBarProps = {
  /**
   * Gates surface-specific FEATURES only — the preset chips and the
   * pending-suggestion badge are shown in `floating` surfaces (chats
   * over a document) and hidden in `standalone` ones. It no longer
   * drives any geometry: position, width, veil, chip offset, and
   * status-row placement all live in `DockedComposer`, so every surface
   * is docked identically regardless of this value.
   */
  layout: FileAIChatLayout;
  status: FileAIChatStatus;
  canSubmitNow?: (() => boolean) | undefined;
  /**
   * Emitted on send. `files` carries any attachments the user added via
   * the shared (+) menu (empty for preset chips, which never attach);
   * callers thread them into `buildChatRequestMessage`.
   */
  onSubmit: (input: {
    prompt: string;
    presetId?: string;
    files?: ChatInputDraft["files"];
  }) => void;
  presetScopeChooser?: PromptBarPresetScopeChooser | undefined;
  /**
   * Pre-saved prompts surfaced as chips above the empty bar. Clicking a
   * chip — or pressing Tab while the input is empty (first preset) —
   * accepts and sends it in one step. Hidden once the thread has any
   * message; starting a new thread brings them back.
   */
  presets?: AISuggestionPreset[] | undefined;
  threadHasMessages?: boolean | undefined;
  /**
   * Optional cancel callback. When provided AND `status` is
   * `"generating"`, the send button morphs into a stop button
   * that calls this on click. Lets a single button toggle
   * between the two intents instead of stacking a second
   * floating control on top of the bar.
   */
  onStop?: () => void;
  /**
   * Offered after a user-initiated stop: while provided AND the
   * composer is empty, the send arrow becomes a retry button that
   * re-runs the stopped prompt. The owner clears it (prop becomes
   * undefined) once the user types a new draft, presses Escape, or
   * starts a new thread.
   */
  onRetry?: (() => void) | undefined;

  // ---- floating-only -----------------------------------------------------
  // Drives the pending-suggestion badge, which only exists in floating
  // mode. Thread-card visibility is owned by the surface: the card
  // carries its own collapse affordance (`ThreadCardCollapseButton`),
  // so the pill renders no thread-visibility control.
  pendingCount: number;

  /**
   * Rich-editor controller from `useChatEditor`. The bar renders
   * the TipTap composer (chips, mentions, drafts) on top of this
   * controller. The Placeholder, Mention, and (future) slash-command
   * extensions live inside the controller's editor — this component
   * is just the chrome around them.
   */
  editorController: ChatEditorController;
  emptyPlaceholder?: ReactNode | undefined;
  /**
   * Monotonic counter from the review store. When it increments
   * the bar plays a one-shot glow — fired by the inspector when
   * the user clicks the AI-suggestions chip, so the producing
   * surface (this bar) lights up briefly to confirm the panel is
   * fed from this chat.
   */
  attentionPulseSeq?: number | undefined;
  /**
   * Whether the bar is allowed to send. False when we know the
   * downstream tool can't be honoured — currently set by the
   * file-chat overlay while the Folio PM view hasn't initialised
   * (no snapshot to attach to apply-active-docx-edits). The send
   * button is disabled and a "Loading editor…" hint replaces the
   * empty-state placeholder so the user doesn't fire a message
   * into a dead context.
   */
  sendDisabledReason?: "editor-loading" | undefined;
  /**
   * When true the composer keeps accepting input while a response
   * streams: pressing Enter queues a send via `useChatSession` and
   * dispatches it once the turn finishes. The single action button
   * still morphs to Stop while generating (there is never a second
   * button); sending mid-turn happens through Enter/submit, which
   * queues the draft.
   */
  queueWhileGenerating?: boolean | undefined;
  /**
   * The status row rendered below the bar, mounted as one organism
   * (`ChatComposerDock`) so a surface can never hand-assemble — or
   * forget — a control. Omit on surfaces with no status row.
   */
  dock?: ReactNode | undefined;
  /**
   * Follow-up-prompt chips stacked above the bar (typically
   * `SuggestedFollowupChips`). Routed through `DockedComposer` so the
   * chip offset stays owned in one place instead of each surface
   * hand-positioning it. Omit on surfaces without follow-up chips.
   */
  followupChips?: ReactNode | undefined;
  /**
   * Opt in to the shared (+) composer menu on the left (attach files via
   * the controller's picker). Only surfaces that thread `files` through
   * `onSubmit` set this; leaving it off keeps the affordance hidden so a
   * surface that can't send attachments never offers a dead control.
   */
  attachmentsEnabled?: boolean | undefined;
};

/**
 * Styled placeholder label rendered in the prompt bar when the editor
 * is empty. Shared between the live `PromptBar` (via `emptyPlaceholder`)
 * and the loading `PromptBarPlaceholder` shell so both surfaces are
 * pixel-identical and can never drift.
 */
export function PromptBarPlaceholderContent({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <span className="text-foreground-muted block min-w-0 truncate text-[13px] leading-5">
      {children}
    </span>
  );
}

type PromptBarShellProps = {
  children: ReactNode;
} & Omit<ComponentProps<"div">, "children">;

/**
 * Background for chrome floating over the document page (prompt bar,
 * suggestion stepper, preset chips). In light mode the rendered page
 * reads as white paper in every accent palette, while `--popover`
 * follows the palette (Flexoki `#fffcf0`, Nord `#eceff4`) — solid but
 * visibly hue-tinted against the document. Anchor these surfaces to
 * the document instead: white in light; in dark the page follows the
 * theme, so the popover token stays correct. (`--doc-canvas` itself
 * is scoped to `.folio-root` and does not reach these elements.)
 */
const DOC_FLOAT_SURFACE_CLASS =
  "[--doc-float-surface:var(--color-white)] dark:[--doc-float-surface:var(--popover)] bg-(--doc-float-surface)";

/**
 * The bar box itself — border, shadow, halo, and the doc-anchored
 * surface — with no positioning or sizing of its own. `DockedComposer`
 * owns where the bar sits and how wide it is; this shell just paints the
 * box and fills the width it is given (`w-full`). Both the live
 * `PromptBar` and the loading `PromptBarPlaceholder` render through it so
 * they can never drift apart.
 *
 * The surface is solid on purpose: a translucent background lets content
 * behind the bar bleed through, and backdrop-blur cannot compensate for
 * children of this shell — the shell's own backdrop-filter would make it
 * the backdrop root for its descendants (the preset chips), whose blur
 * then samples nothing. The solid `DOC_FLOAT_SURFACE_CLASS` is the anchor
 * (white in light, the theme popover in dark); the halo fades the content
 * around the bar toward the page so it reads as floating over it.
 */
export function PromptBarShell({
  children,
  className,
  ...rest
}: PromptBarShellProps) {
  return (
    <div
      {...rest}
      className={cn(
        "group/bar border-foreground/15 relative flex w-full items-end gap-1 rounded-2xl border transition-[box-shadow,border-color]",
        "shadow-[0_0_0_1px_rgb(0_0_0/0.02),0_1px_2px_rgb(0_0_0/0.03),0_8px_20px_rgb(0_0_0/0.05)]",
        "after:pointer-events-none after:absolute after:-inset-6 after:-z-10 after:rounded-3xl after:bg-[radial-gradient(ellipse_at_center,var(--doc-float-halo)_0%,transparent_75%)] after:opacity-90",
        // py-0.5 keeps the single-line pill slim (the inner editor cell's
        // min-h-8 sets the line height; the shell adds only a hairline of
        // breathing room) so the bar reads lighter than the transcript.
        "py-0.5 ps-1.5 pe-1",
        DOC_FLOAT_SURFACE_CLASS,
        // The halo fades content around the bar, so it blends toward the
        // page: white in light, the theme background in dark.
        "[--doc-float-halo:var(--color-white)] dark:[--doc-float-halo:var(--background)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Shared width of the docked composer column and any floating thread
 * card that aligns to it. One owner so the bar and the card can never
 * drift to different widths.
 */
const DOCKED_COMPOSER_WIDTH_CLASS = "w-[min(560px,calc(100%-2rem))]";

/**
 * Bottom offset for a floating `ChatThreadCard` so it clears the docked
 * composer stack that `DockedComposer` pins at `bottom-3.5` (14px).
 *
 * Stack, measured from the pane's bottom edge: 14px column offset +
 * ~24px status row (icon-xs controls) + 6px bar-to-row gap (`mt-1.5`) +
 * ~38px bar (min-h-8 cell + py-0.5 + border) ⇒ the bar's TOP sits ~82px
 * up. `bottom-24` (96px) drops the card ~14px above that, matching the
 * transcript's rhythm. (Both floating surfaces render a status row; a
 * bar-only stack would clear this offset with room to spare.)
 */
const FLOATING_THREAD_CARD_OFFSET_CLASS = "bottom-24";

type DockedComposerProps = {
  /**
   * Follow-up chips stacked directly above the bar. Owns no offset of
   * its own — the chips component carries its own bottom spacing and
   * collapses to nothing when it has nothing to show, so no phantom gap
   * appears above the bar.
   */
  chips?: ReactNode;
  /** The prompt bar itself (a `PromptBarShell`). */
  bar: ReactNode;
  /**
   * Status row beneath the bar (matter picker, context meter, send-mode
   * shield). Anchored flush under the bar with the single owned gap.
   */
  dock?: ReactNode;
};

/**
 * The one and only owner of the docked-composer geometry.
 *
 * Every chat surface — the inspector chat tab, the file-overlay chat,
 * the Template Studio chat — mounts its `PromptBar` through this, so the
 * bar's width, its bottom offset from the host pane, the follow-up-chip
 * offset, and the status-row placement live in exactly one place and can
 * never drift between surfaces. The column pins to the bottom of the
 * nearest positioned host pane and centres itself; the wrapper is
 * click-through so scrolled content behind the composer stays reachable
 * in the gaps, while the bar, chips, and dock capture their own clicks.
 *
 * The bar sits above a surface's own thread panel (z-50 vs the panel's
 * z-40) so the two never fight where they meet, and the chips sit below
 * it (z-30) so an open thread wins the overlap.
 */
export function DockedComposer({ chips, bar, dock }: DockedComposerProps) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3.5 flex flex-col items-center">
      {chips !== undefined && (
        <div
          className={cn(
            "pointer-events-auto relative z-30 px-1",
            DOCKED_COMPOSER_WIDTH_CLASS,
          )}
        >
          {chips}
        </div>
      )}
      <div
        className={cn(
          "pointer-events-auto relative z-50 flex flex-col",
          DOCKED_COMPOSER_WIDTH_CLASS,
        )}
      >
        {/* Shared glass veil behind the whole composer stack (bar + status
            row). Legibility over live document content comes from this one
            heavy blur band, not from per-control chrome: the status-row
            controls stay quiet muted text/icons sitting directly on it.
            Negative insets let it overhang the stack and reach the pane's
            bottom edge (the column floats 3.5 above it). */}
        <ComposerVeil className="-inset-x-3 -top-4 -bottom-3.5" />
        {bar}
        {/* No extra top margin: `ComposerStatusRow` owns the single
            bar-to-row gap (mt-1.5), same rhythm as the main chat tray. */}
        {dock !== undefined && <div className="px-1">{dock}</div>}
      </div>
    </div>
  );
}

/**
 * Collapse affordance rendered by `ChatThreadCard` in its top end
 * corner, so the composer bar never carries a thread-visibility
 * control. The card reopens automatically on the next send.
 */
function ThreadCardCollapseButton({ onCollapse }: { onCollapse: () => void }) {
  const t = useTranslations();
  return (
    <Button
      aria-label={t("chat.hideThread")}
      className="text-muted-foreground hover:text-foreground absolute end-1.5 top-1.5 z-20 rounded-full"
      onClick={onCollapse}
      size="icon-xs"
      tooltip={t("chat.hideThread")}
      type="button"
      variant="ghost"
    >
      <ChevronDownIcon aria-hidden="true" className="size-3.5" />
    </Button>
  );
}

type ChatThreadCardProps = {
  /** Scroll container ref for the transcript inside the card. */
  scrollRef: RefObject<HTMLDivElement | null>;
  onCollapse: () => void;
  children: ReactNode;
};

/**
 * The floating glass thread card shared by the file-chat overlay and
 * Template Studio. One owner of the card's geometry (aligned to the
 * `DockedComposer` stack via the shared width + offset constants), its
 * glass treatment, the collapse affordance, and the scrolling transcript
 * container, so the two surfaces can never drift. Surfaces pass only
 * their transcript (and any suggestion list) as children.
 */
export function ChatThreadCard({
  scrollRef,
  onCollapse,
  children,
}: ChatThreadCardProps) {
  const t = useTranslations();
  return (
    <div
      aria-label={t("chat.aiThread")}
      className={cn(
        "absolute start-1/2 z-40 flex max-h-[min(45dvh,380px)] min-h-0 -translate-x-1/2 flex-col overflow-hidden rounded-2xl border",
        FLOATING_THREAD_CARD_OFFSET_CLASS,
        DOCKED_COMPOSER_WIDTH_CLASS,
        "bg-popover/90 border-border text-popover-foreground",
        "[backdrop-filter:blur(18px)_saturate(160%)] [-webkit-backdrop-filter:blur(18px)_saturate(160%)]",
        "before:bg-foreground/[0.06] before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px",
        "hover:bg-popover focus-within:bg-popover",
        "transition-[background-color,border-color] duration-200 ease-out",
        "shadow-[0_1px_2px_rgb(0_0_0/0.06),0_20px_64px_rgb(0_0_0/0.18)]",
        "animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-1",
      )}
      role="dialog"
    >
      <ThreadCardCollapseButton onCollapse={onCollapse} />
      {/* Plain scroll container — bypasses the legacy Conversation's
          `size-full` chain, which only resolves when the parent has an
          explicit height (this card caps with `max-h` only, so flex-1
          children get no definite size to base `size-full` on). */}
      <div
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3"
        ref={scrollRef}
        style={{ scrollbarGutter: "stable" }}
      >
        {children}
      </div>
    </div>
  );
}

type SuggestionStepperProps = {
  index: number;
  total: number;
  onStep: (delta: number) => void;
  onAccept: () => void;
  onDismiss: () => void;
};

/** Compact floating review bar: step through the pending suggestions in
 *  document order and accept/dismiss each in place. Shared with the
 *  Template Studio chat, which feeds it tool-call suggestions. */
export function SuggestionStepper({
  index,
  total,
  onStep,
  onAccept,
  onDismiss,
}: SuggestionStepperProps) {
  const t = useTranslations();
  return (
    <div
      className={cn(
        DOC_FLOAT_SURFACE_CLASS,
        "border-foreground/15 absolute start-1/2 bottom-26 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full border px-1.5 py-1 shadow-[0_0_0_1px_rgb(0_0_0/0.02),0_1px_2px_rgb(0_0_0/0.03),0_8px_20px_rgb(0_0_0/0.05)]",
      )}
    >
      <Button
        aria-label={t("common.previous")}
        onClick={() => onStep(-1)}
        size="icon-sm"
        variant="ghost"
      >
        <DirectionalIcon icon={ChevronLeftIcon} />
      </Button>
      <span className="text-muted-foreground min-w-12 text-center text-xs tabular-nums">
        {t("chat.suggestionStep", {
          current: String(index + 1),
          total: String(total),
        })}
      </span>
      <Button
        aria-label={t("common.next")}
        onClick={() => onStep(1)}
        size="icon-sm"
        variant="ghost"
      >
        <DirectionalIcon icon={ChevronRightIcon} />
      </Button>
      <Button className="ms-1" onClick={onDismiss} size="sm" variant="ghost">
        {t("folio.dismiss")}
      </Button>
      <Button onClick={onAccept} size="sm">
        {t("common.accept")}
      </Button>
    </div>
  );
}

export function PromptBar(props: PromptBarProps) {
  const {
    layout,
    status,
    pendingCount,
    canSubmitNow,
    onSubmit,
    presetScopeChooser,
    presets,
    threadHasMessages = false,
    onStop,
    onRetry,
    editorController,
    emptyPlaceholder,
    attentionPulseSeq,
    sendDisabledReason,
    queueWhileGenerating = false,
    dock,
    followupChips,
    attachmentsEnabled = false,
  } = props;

  const t = useTranslations();
  const format = useFormatter();
  const {
    attachments,
    canSubmit,
    editor,
    fileInputAccept,
    fileInputRef,
    handleFileInputChange,
    isEmpty,
    openFilePicker,
    removeFile,
  } = editorController;

  const isGenerating = status === "generating";
  const busy = isGenerating || status === "applying";
  const isSendBlocked = sendDisabledReason !== undefined;
  const inputDisabled = isSendBlocked;
  const submitDisabled = busy || isSendBlocked;
  // With queuing enabled the composer keeps accepting input while a
  // response streams: `useChatSession` holds submitted drafts until the
  // turn finishes. The single action button still morphs to Stop while
  // generating (on every surface); sending mid-turn happens through
  // Enter/submit, which queues the draft — same behaviour as the main
  // chat, and structurally no second button can appear beside it.
  const composerSubmitDisabled = queueWhileGenerating
    ? status === "applying" || isSendBlocked
    : submitDisabled;
  // After a stop the send arrow becomes Retry until the user starts
  // a new draft (the owner also clears `onRetry` then; the `isEmpty`
  // gate just avoids a one-render flash before that state lands).
  // Passing `undefined` otherwise keeps the offer out of the button's
  // state entirely, so it can never shadow Send while typing.
  const retryOffer =
    onRetry !== undefined && isEmpty && !busy && !isSendBlocked
      ? onRetry
      : undefined;
  const composerActionMode = resolveChatComposerAction({
    isGenerating,
    onStop,
    onRetry: retryOffer,
  });

  // Glow on attention pulse — kicked from the inspector when the
  // user clicks the AI-suggestions chip so they see the bar light
  // up and connect "the suggestions came from this chat". One-shot
  // 1.4s ring; restart when the seq advances.
  const { isPulsing: attention, pulse: triggerAttention } = usePulse(1400);
  const lastAttentionSeq = useRef(attentionPulseSeq);
  // eslint-disable-next-line no-raw-use-effect/no-raw-use-effect -- event-relay (attention-pulse seq advance → fire one-shot glow); move into the pulse trigger source
  useEffect(() => {
    if (
      attentionPulseSeq === undefined ||
      attentionPulseSeq === lastAttentionSeq.current
    ) {
      return;
    }
    lastAttentionSeq.current = attentionPulseSeq;
    triggerAttention();
  }, [attentionPulseSeq, triggerAttention]);

  // The bar emits `{ prompt }`; the underlying composer emits the
  // raw editor draft. Adapting here lets the rest of the wiring
  // (Enter handler, blur/setEditable, submit gating) stay shared.
  const handleComposerSubmit = useCallback(
    (draft: ChatInputDraft) => {
      onSubmit({ prompt: draft.html, files: draft.files });
    },
    [onSubmit],
  );

  const { submitDraft } = useChatComposerWiring({
    controller: editorController,
    inputDisabled,
    onSubmit: handleComposerSubmit,
    onSubmitGuard: canSubmitNow,
    submitDisabled: composerSubmitDisabled,
  });

  // Preset chips: visible over the empty idle bar; click — or Tab with an
  // empty input — accepts and sends the preset in one step.
  const presetChipsVisible =
    layout === "floating" &&
    !threadHasMessages &&
    presets !== undefined &&
    presets.length > 0 &&
    isEmpty &&
    !busy &&
    !isSendBlocked;
  /**
   * Scoped preset awaiting the inline "Selected part / Entire
   * document" choice. While set, the chip row renders the two-option
   * chooser instead of the chips; Escape or losing chip visibility
   * cancels back to the chips.
   */
  const [scopePromptPreset, setScopePromptPreset] =
    useState<AISuggestionPreset | null>(null);
  // eslint-disable-next-line no-raw-use-effect/no-raw-use-effect -- event-relay (preset chips lose visibility → cancel the scope chooser); setScopePromptPreset is shared with submitPreset, so move into the visibility-change source
  useEffect(() => {
    if (!presetChipsVisible && scopePromptPreset !== null) {
      setScopePromptPreset(null);
    }
  }, [presetChipsVisible, scopePromptPreset]);
  const submitPreset = useCallback(
    (preset: AISuggestionPreset) => {
      if (canSubmitNow !== undefined && !canSubmitNow()) {
        return;
      }
      if (
        presetScopeChooser !== undefined &&
        presetScopeChooser.appliesTo(preset)
      ) {
        if (presetScopeChooser.shouldAskForScope()) {
          setScopePromptPreset(preset);
          return;
        }
        presetScopeChooser.onSubmit(preset, "document");
        return;
      }
      onSubmit({ prompt: preset.prompt, presetId: preset.id });
    },
    [canSubmitNow, onSubmit, presetScopeChooser],
  );
  const resolvePresetScope = useCallback(
    (scope: PromptBarPresetScope) => {
      const preset = scopePromptPreset;
      setScopePromptPreset(null);
      if (preset === null || presetScopeChooser === undefined) {
        return;
      }
      presetScopeChooser.onSubmit(preset, scope);
    },
    [scopePromptPreset, presetScopeChooser],
  );
  // Tab with an empty input writes the first preset INTO the composer (the
  // user can edit before sending); clicking a chip accepts and sends as-is.
  // Escape backs out of the inline preset-scope chooser.
  const handleShellKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.key === "Escape" && scopePromptPreset !== null) {
        event.preventDefault();
        setScopePromptPreset(null);
        return;
      }
      if (event.key !== "Tab" || event.shiftKey || !presetChipsVisible) {
        return;
      }
      const first = presets.at(0);
      if (!first || !editor) {
        return;
      }
      event.preventDefault();
      editor.chain().focus().insertContent(first.prompt).run();
    },
    [presetChipsVisible, presets, editor, scopePromptPreset],
  );

  const shell = (
    <PromptBarShell
      aria-busy={busy}
      aria-label={t("chat.aiPrompt")}
      onKeyDownCapture={handleShellKeyDown}
      className={cn(
        !inputDisabled && "focus-within:border-foreground/30",
        // Attention pulse — kicked by the inspector chip click to
        // close the panel→producer loop visually. Stronger ring
        // than the busy state because it's transient and meant to
        // catch the eye, not communicate ongoing work.
        attention && !inputDisabled && "border-primary ring-primary/40 ring-4",
      )}
      role="toolbar"
      tabIndex={-1}
    >
      {presetChipsVisible &&
        scopePromptPreset !== null &&
        presetScopeChooser !== undefined && (
          <div className="absolute start-1 bottom-full mb-3 flex items-start">
            <span
              className={cn(
                DOC_FLOAT_SURFACE_CLASS,
                "border-foreground/15 inline-flex items-center gap-1.5 rounded-full border py-1 ps-3 pe-1 shadow-[0_1px_2px_rgb(0_0_0/0.03),0_8px_20px_rgb(0_0_0/0.05)]",
              )}
            >
              <span className="text-muted-foreground text-[12px] font-medium">
                {presetScopeChooser.question}
              </span>
              <Button
                className="h-7 rounded-full px-2.5 text-[12.5px]"
                onClick={() => resolvePresetScope("selection")}
                size="sm"
                type="button"
                variant="ghost"
              >
                {presetScopeChooser.selectionLabel}
              </Button>
              <Button
                className="h-7 rounded-full px-2.5 text-[12.5px]"
                onClick={() => resolvePresetScope("document")}
                size="sm"
                type="button"
                variant="ghost"
              >
                {presetScopeChooser.documentLabel}
              </Button>
            </span>
          </div>
        )}
      {presetChipsVisible && scopePromptPreset === null && (
        <div className="absolute start-1 bottom-full mb-3 flex flex-col items-start gap-1.5">
          {presets.map((preset) => (
            // The opaque surface lives on a wrapper, not the Button:
            // the ghost variant swaps `background-color` to the
            // translucent `--accent` on hover, which over the bare
            // document would make the chip see-through under the
            // cursor. Over the wrapper's solid surface the same swap
            // is the standard menu-item tint.
            <span
              className={cn(
                DOC_FLOAT_SURFACE_CLASS,
                "border-foreground/15 inline-flex rounded-full border shadow-[0_1px_2px_rgb(0_0_0/0.03),0_8px_20px_rgb(0_0_0/0.05)]",
              )}
              key={preset.id}
            >
              <Button
                aria-keyshortcuts="Tab"
                className="text-foreground h-9 gap-2.5 rounded-full px-3 text-[13px] font-medium transition-[background-color] duration-150"
                onClick={() => submitPreset(preset)}
                size="sm"
                type="button"
                variant="ghost"
              >
                <WandSparklesIcon aria-hidden="true" className="size-4" />
                {preset.label}
              </Button>
            </span>
          ))}
        </div>
      )}
      {attachmentsEnabled && (
        <>
          {attachments.length > 0 && (
            // Attachments float above the bar in an opaque tray so the chips
            // (translucent `bg-muted/50`) stay readable over a document in
            // floating mode; the bar's own single row is left untouched.
            <div
              className={cn(
                DOC_FLOAT_SURFACE_CLASS,
                "border-foreground/15 absolute inset-x-1 bottom-full mb-2 overflow-hidden rounded-xl border shadow-[0_1px_2px_rgb(0_0_0/0.03),0_8px_20px_rgb(0_0_0/0.05)]",
              )}
            >
              <ChatDraftAttachmentChips
                files={attachments}
                onRemove={removeFile}
              />
            </div>
          )}
          <input
            accept={fileInputAccept}
            className="hidden"
            disabled={inputDisabled}
            multiple
            onChange={handleFileInputChange}
            ref={fileInputRef}
            type="file"
          />
          {/* Shared (+) affordance on the left, identical to the main chat
              composer; opens the attach-file picker via the same controller.
              The h-8 wrapper (same pattern as the pending badge below)
              centers the size-7 circle on the editor cell's single-line
              height: the shell is items-end, so the bare 28px button would
              otherwise ride 2px below the placeholder's center line. */}
          <span className="flex h-8 shrink-0 items-center">
            <ComposerPlusMenu
              disabled={inputDisabled}
              onOpenFilePicker={openFilePicker}
            />
          </span>
        </>
      )}
      {layout === "floating" && pendingCount > 0 && (
        <span className="flex h-8 shrink-0 items-center ps-0.5">
          <span className="bg-muted text-foreground inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums">
            {format.number(pendingCount)}
          </span>
        </span>
      )}
      <div className="relative flex min-h-8 min-w-0 flex-1 items-center gap-1.5 px-1.5">
        {isEmpty && busy && (
          <div className="text-muted-foreground pointer-events-none absolute inset-x-1.5 top-1/2 z-10 flex min-w-0 -translate-y-1/2 items-center gap-2 text-[13px]">
            <LoaderCircleIcon
              aria-hidden="true"
              className="size-3.5 shrink-0 animate-spin"
            />
            <span className="truncate">{t("chat.thinking")}</span>
          </div>
        )}
        {isEmpty && !busy && isSendBlocked && (
          <div className="text-muted-foreground pointer-events-none absolute inset-x-1.5 top-1/2 z-10 flex min-w-0 -translate-y-1/2 items-center gap-2 text-[13px]">
            <LoaderCircleIcon
              aria-hidden="true"
              className="size-3.5 shrink-0 animate-spin"
            />
            <span className="truncate">{t("chat.editorLoading")}</span>
          </div>
        )}
        {isEmpty &&
          !busy &&
          !isSendBlocked &&
          emptyPlaceholder !== undefined && (
            <div className="pointer-events-none absolute inset-0 z-10 flex min-w-0 items-center px-1.5">
              {emptyPlaceholder}
            </div>
          )}
        <PromptEditorContent
          // Height is content-driven: a single line of 13px text
          // is ~20px tall (`leading-5`) and the cell's `min-h-8`
          // (2rem) + `items-center` centres it vertically;
          // multiple wrapped lines stay tight. The cell grows up
          // to `max-h-32` before scrolling, and `min-h-0`
          // overrides the provider's `min-h-10` so it shrinks
          // back as the user deletes content.
          className={cn(
            "folio-ai-bar-editor text-foreground min-w-0 flex-1 [&_.ProseMirror]:field-sizing-fixed [&_.ProseMirror]:max-h-32 [&_.ProseMirror]:min-h-0 [&_.ProseMirror]:overflow-y-auto [&_.ProseMirror]:py-1.5 [&_.ProseMirror]:text-[13px] [&_.ProseMirror]:leading-5 [&_.ProseMirror]:select-text [&_.ProseMirror]:focus-visible:outline-none [&_.ProseMirror_p]:my-0",
            // Suppress the composer's own placeholder whenever the host
            // renders an overlay in the same cell (custom placeholder, the
            // busy "working" label, or the editor-loading label) — otherwise
            // the two texts paint on top of each other.
            isEmpty &&
              (emptyPlaceholder !== undefined || busy || isSendBlocked) &&
              "folio-ai-bar-editor--custom-placeholder",
            inputDisabled && "pointer-events-none",
          )}
          editor={editor}
        />
      </div>

      <Tooltip>
        <TooltipTrigger
          render={
            // The h-8 wrapper mirrors the (+) menu's centering: the shell
            // is items-end, so a bare size-7 circle would sit 2px below
            // the editor cell's single-line center. Bottom-aligned at the
            // cell's min-h-8, the wrapper centers the circle on the
            // placeholder line and rides the bottom text line as the
            // editor grows.
            <span className="flex h-8 shrink-0 items-center">
              <ChatComposerActionButton
                canSend={!composerSubmitDisabled && canSubmit}
                isGenerating={isGenerating}
                onRetry={retryOffer}
                onSend={() => {
                  void submitDraft();
                }}
                onStop={onStop}
              />
            </span>
          }
        />
        <TooltipPopup side="top">
          {/* Labels the same state the button resolves internally —
              `composerActionMode` comes from the button module's own
              resolver, so the tooltip cannot drift from the morph. */}
          {(() => {
            if (composerActionMode === "stop") {
              return t("chat.stopResponse");
            }
            if (composerActionMode === "retry") {
              return t("common.retry");
            }
            if (canSubmit) {
              return t("chat.sendPrompt");
            }
            return t("chat.askAnything");
          })()}
        </TooltipPopup>
      </Tooltip>
    </PromptBarShell>
  );

  // One docked layout for every surface: `DockedComposer` owns the bar's
  // position, width, the follow-up-chip offset, and the status-row
  // placement, so the inspector chat and the file-overlay chat are
  // positionally identical by construction. Surface-specific features
  // (preset chips, the pending badge, the thread-toggle chevron) stay
  // gated on props above; only geometry is unified here.
  return (
    <DockedComposer
      bar={shell}
      {...(followupChips === undefined ? {} : { chips: followupChips })}
      {...(dock === undefined ? {} : { dock })}
    />
  );
}

type SuggestionCardProps = {
  suggestion: AISuggestion;
  focused: boolean;
  showAcceptUI: boolean;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onFocus: (id: string) => void;
};

export function SuggestionCard(props: SuggestionCardProps) {
  const t = useTranslations();
  const { suggestion, focused, showAcceptUI, onAccept, onReject, onFocus } =
    props;
  const { display } = suggestion;
  const isResolvable =
    suggestion.status === "pending" || suggestion.status === "stale";
  // For display-carrying (field) suggestions the rationale is often just
  // the field path again — the header and replacement row already show it.
  const showRationale =
    suggestion.rationale.length > 0 &&
    (!display || suggestion.rationale !== suggestion.topic);

  return (
    // The whole card is a click target for focus-and-jump (the header
    // button stays the keyboard/AT path); clicks owned by interior
    // buttons (header, accept, reject) are skipped so they don't
    // double-fire.
    // oxlint-disable-next-line jsx_a11y/no-static-element-interactions, jsx_a11y/click-events-have-key-events
    <div
      data-status={suggestion.status}
      onClick={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest("button") !== null
        ) {
          return;
        }
        onFocus(suggestion.id);
      }}
      className={cn(
        "border-border/60 bg-background/60 cursor-pointer rounded-lg border px-3 py-2 transition-colors",
        focused && "border-foreground-disabled bg-muted/40",
      )}
    >
      <button
        type="button"
        className="text-muted-foreground flex w-full cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-start text-[11px]"
        onClick={() => onFocus(suggestion.id)}
        aria-label={t("chat.focusSuggestion", { topic: suggestion.topic })}
      >
        {display ? (
          <SuggestionDisplayBadges display={display} />
        ) : (
          <>
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                SEVERITY_DOT_CLASS[suggestion.severity],
              )}
              aria-hidden="true"
            />
            <span className="text-foreground font-medium">
              {suggestion.topic}
            </span>
            <span aria-hidden="true">·</span>
            <span>{t(SEVERITY_LABEL_KEYS[suggestion.severity])}</span>
          </>
        )}
        {suggestion.status === "stale" && (
          <span className="bg-destructive/12 text-destructive ms-1 inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium tracking-wider uppercase">
            {t("chat.suggestionStatus.stale")}
          </span>
        )}
        {suggestion.status === "accepted" && (
          <span className="bg-success/15 text-success ms-1 inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium tracking-wider uppercase">
            {t("chat.suggestionStatus.accepted")}
          </span>
        )}
        {suggestion.status === "rejected" && (
          <span className="bg-muted text-muted-foreground ms-1 inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium tracking-wider uppercase">
            {t("chat.suggestionStatus.rejected")}
          </span>
        )}
      </button>

      {display ? (
        <>
          <div className="bg-muted text-foreground mt-2 rounded-md px-2.5 py-1.5 text-[13px] leading-snug text-pretty break-words">
            <span className="decoration-foreground-ghost line-through">
              {suggestion.originalText}
            </span>
          </div>
          <div className="text-muted-foreground mt-1 px-2.5 font-mono text-[11px] leading-snug break-all">
            {suggestion.suggestedText}
          </div>
        </>
      ) : (
        <>
          <div className="bg-muted text-muted-foreground mt-2 flex flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-[12.5px] leading-snug text-pretty break-words">
            <div className="flex gap-1.5">
              <span
                className="text-muted-foreground w-3 shrink-0 text-center tabular-nums"
                aria-hidden="true"
              >
                −
              </span>
              <span className="decoration-foreground-ghost line-through">
                {suggestion.originalText}
              </span>
            </div>
          </div>
          <div className="bg-muted text-foreground mt-1 flex flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-[12.5px] leading-snug text-pretty break-words">
            <div className="flex gap-1.5">
              <span
                className="text-muted-foreground w-3 shrink-0 text-center tabular-nums"
                aria-hidden="true"
              >
                +
              </span>
              <span>
                {suggestion.suggestedText.length === 0
                  ? t("chat.removeSuggestion")
                  : suggestion.suggestedText}
              </span>
            </div>
          </div>
        </>
      )}

      {showRationale && (
        <p className="text-muted-foreground mt-1.5 text-xs leading-snug text-pretty">
          {suggestion.rationale}
        </p>
      )}

      {showAcceptUI && isResolvable && (
        <div className="mt-2 flex items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            className="rounded-md"
            onClick={() => onAccept(suggestion.id)}
            disabled={suggestion.status === "stale"}
          >
            <CheckIcon aria-hidden="true" />
            {t("common.accept")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="rounded-md"
            onClick={() => onReject(suggestion.id)}
          >
            {t("docxReview.reject")}
          </Button>
        </div>
      )}
    </div>
  );
}

type SuggestionDisplayBadgesProps = {
  display: NonNullable<AISuggestion["display"]>;
};

/** Header badges for display-carrying suggestions: the payload's value
 *  type plus who fills it (replaces the severity dot + label). */
function SuggestionDisplayBadges({ display }: SuggestionDisplayBadgesProps) {
  return (
    <>
      {display.valueKind !== undefined && (
        <ValueKindChip valueKind={display.valueKind} />
      )}
      {display.filledBy !== undefined && (
        <FilledByBadge filledBy={display.filledBy} />
      )}
    </>
  );
}

type FilledByBadgeProps = {
  filledBy: NonNullable<NonNullable<AISuggestion["display"]>["filledBy"]>;
};

/** Who fills the proposed field: a person, AI, or a person whose stub
 *  AI adapts in place (`personAi`). */
function FilledByBadge({ filledBy }: FilledByBadgeProps) {
  const t = useTranslations();
  if (filledBy === "ai") {
    return (
      <span className="bg-info/10 text-info inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium">
        <WandSparklesIcon aria-hidden="true" className="size-3 shrink-0" />
        {t("templates.studio.draftedByAi")}
      </span>
    );
  }
  if (filledBy === "personAi") {
    return (
      <span className="bg-info/10 text-info inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium">
        <UserIcon aria-hidden="true" className="size-3 shrink-0" />
        <WandSparklesIcon aria-hidden="true" className="size-3 shrink-0" />
        {t("templates.studio.textPlusAi")}
      </span>
    );
  }
  return (
    <span className="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium">
      <UserIcon aria-hidden="true" className="size-3 shrink-0" />
      {t("templates.studio.filledByPerson")}
    </span>
  );
}

function ValueKindChip({ valueKind }: { valueKind: string }) {
  const t = useTranslations();
  if (!isValueTypeKind(valueKind)) {
    return null;
  }
  const meta = VALUE_TYPE_META[valueKind];
  const Icon = meta.icon;
  return (
    <span className="text-foreground inline-flex min-w-0 items-center gap-1 font-medium">
      <Icon aria-hidden="true" className="size-3.5 shrink-0 opacity-70" />
      <span className="truncate">{t(meta.labelKey)}</span>
    </span>
  );
}
