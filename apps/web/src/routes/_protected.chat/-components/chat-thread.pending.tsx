import type { ReactNode, Ref } from "react";

import { ButtonFace } from "@stll/ui/control-face";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { HistoryIcon, MoveToSideIcon, NewChatIcon } from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

import { ConversationPending } from "@/components/ai-elements/conversation.pending";
import { ChatMessageSkeleton } from "@/components/ai-elements/message.pending";
import { ChatComposerDockPending } from "@/components/chat/chat-composer-dock.pending";
import { ChatMatterPickerPending } from "@/components/chat/chat-matter-picker.pending";
import { ChatComposerPending } from "@/components/chat/composer-row.pending";
import { ComposerVeil } from "@/components/chat/composer-veil.pending";
import { PendingText } from "@/components/pending-text";
import { ChromeHeaderActions } from "@/lib/chrome-header-actions";
import { framePendingView } from "@/routes/-pending-view.logic";
import {
  CHAT_COMPOSER_COLUMN_CLASS_NAME,
  CHAT_READING_COLUMN_CLASS_NAME,
} from "@/routes/_protected.chat/-components/chat-reading-column";

/**
 * The transcript column: the thread's reading column, its bottom padding
 * clear of the floating composer block (`--composer-block-h`, published by
 * the page) and of the fade above it.
 */
export const CHAT_THREAD_TRANSCRIPT_CLASS = cn(
  CHAT_READING_COLUMN_CLASS_NAME,
  "gap-3 pb-[max(var(--chat-bottom-fade-h),calc(var(--composer-block-h,7rem)+1.5rem))]",
);

/** The transcript's log box inside the scroll surface. */
export const CHAT_THREAD_CONVERSATION_CLASS = "@container isolate min-h-0";

/** The header's "move to side" control, which narrow screens leave out. */
export const CHAT_THREAD_MOVE_TO_SIDE_CLASS = "hidden md:inline-flex";

/** The header's "new chat" label: read aloud on narrow screens, shown on wide. */
export const CHAT_THREAD_NEW_CHAT_LABEL_CLASS = "sr-only md:not-sr-only";

type ChatThreadShellProps = {
  /** The page's header actions (`ChromeHeaderActions`), in the app's top bar. */
  headerActions: ReactNode;
  /** A notice above the transcript (the thread this one was forked from). */
  banner?: ReactNode;
  /** The transcript itself. */
  transcript: ReactNode;
  /** Layers over the transcript (announcer, anonymization, fade). */
  overlays?: ReactNode;
  /** The floating composer block, which publishes its height for the page. */
  composerBlockRef?: Ref<HTMLDivElement> | undefined;
  /** Above the composer in its block: follow-up chips, notices. */
  aboveComposer?: ReactNode;
  /** The composer and its status row. */
  composer: ReactNode;
};

/**
 * The chat thread's one layout, drawn by both phases: the header actions,
 * the transcript filling the page, and the composer floating at its foot on
 * the glass tray. The loaded page fills the slots with the live transcript
 * and composer; the pending phase with placeholder turns and the composer's
 * faces, at the same places.
 */
export const ChatThreadShell = ({
  aboveComposer,
  banner,
  composer,
  composerBlockRef,
  headerActions,
  overlays,
  transcript,
}: ChatThreadShellProps) => (
  <div className="relative flex w-full flex-1 flex-col overflow-hidden">
    {headerActions}
    {/*
      Page-level stacking order (bottom → top):
        1. transcript content   — in-flow, z-auto
        2. sticky user headers  — z-10 (capped inside the isolated log)
        3. fade gradient        — z-auto sibling, above the isolated log
        4. composer             — z-20, floats above everything
      `isolate` on the log traps every transcript stacking value (sticky
      headers, scroll button) inside its own context so none of them can
      leak up and overlay the fade or the composer.
    */}
    {banner}
    <div
      className="group/chat-scroll-surface relative flex min-h-0 flex-1 flex-col [--chat-bottom-fade-h:12rem]"
      data-composer-host=""
    >
      {transcript}
      {overlays}
      {/* Top of the page stacking order: `z-20` beats the isolated log
          (which caps its sticky headers at z-10) and the z-auto fade.

          No bottom padding: the block hugs the pane bottom so the glass
          veil behind the tray reaches the bottom edge with no unblurred
          strip of transcript beneath the status row. The tray's `p-2`
          keeps the composer breathing inside the veil. */}
      <div
        className={cn(
          CHAT_COMPOSER_COLUMN_CLASS_NAME,
          "absolute inset-x-0 bottom-0 z-20",
        )}
        ref={composerBlockRef}
      >
        {aboveComposer}
        {/* The shared glass veil fills this `relative isolate` tray, so the
            floating status-row text stays readable over the transcript. */}
        <div className="relative isolate p-2">
          <ComposerVeil />
          {composer}
        </div>
      </div>
    </div>
  </div>
);

/** The header actions while the thread loads, in their unavailable faces. */
const ChatThreadHeaderActionsPending = () => (
  <ChromeHeaderActions>
    <ButtonFace
      className={CHAT_THREAD_MOVE_TO_SIDE_CLASS}
      size="icon-sm"
      variant="ghost"
    >
      <DirectionalIcon className="size-4" icon={MoveToSideIcon} />
    </ButtonFace>
    <ButtonFace size="icon-sm" variant="ghost">
      <HistoryIcon className="size-4" />
    </ButtonFace>
    <ButtonFace size="sm" variant="ghost">
      <NewChatIcon />
      <span className={CHAT_THREAD_NEW_CHAT_LABEL_CLASS}>
        <PendingText barClassName="w-14" id="chat.newChat" />
      </span>
    </ButtonFace>
  </ChromeHeaderActions>
);

/** Placeholder turns: a question and its answer, twice. */
const CHAT_THREAD_TURNS_PENDING = [
  { key: "a", from: "user" },
  { key: "b", from: "assistant" },
  { key: "c", from: "user" },
  { key: "d", from: "assistant" },
] as const;

/**
 * The chat thread in its pending phase: the header actions and the composer
 * in their faces (the (+) menu, send, the matter picker, the toggles and the
 * meter, at their places), and placeholder turns where the transcript loads.
 */
const ChatThreadPendingView = () => (
  <ChatThreadShell
    composer={
      <ChatComposerPending
        dock={
          <ChatComposerDockPending
            leadingContext={<ChatMatterPickerPending />}
          />
        }
        placeholder={<PendingText barClassName="w-40" id="chat.placeholder" />}
      />
    }
    headerActions={<ChatThreadHeaderActionsPending />}
    transcript={
      <ConversationPending
        className={CHAT_THREAD_CONVERSATION_CLASS}
        contentClassName={CHAT_THREAD_TRANSCRIPT_CLASS}
      >
        {CHAT_THREAD_TURNS_PENDING.map((turn) => (
          <ChatMessageSkeleton from={turn.from} key={turn.key} />
        ))}
      </ConversationPending>
    }
  />
);

export const ChatThreadPending = framePendingView(ChatThreadPendingView);
