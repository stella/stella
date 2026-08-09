import { useRef } from "react";

import { Loader2Icon, WandSparklesIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/components/bidi-text";
import { Button } from "@stll/ui/components/button";
import { cn } from "@stll/ui/lib/utils";

import { InlineEdit } from "@/components/inline-edit";
import Tooltip from "@/components/tooltip";
import { useRenameChatThread } from "@/features/chat/hooks/use-rename-chat-thread";
import { useSuggestChatThreadTitle } from "@/features/chat/hooks/use-suggest-chat-thread-title";
import { useChatRenameCommandStore } from "@/features/chat/lib/chat-rename-command-store";
import { useMountEffect } from "@/hooks/use-effect";
import { useInlineRename } from "@/hooks/use-inline-rename";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { useChatAnonymized } from "@/lib/chat-anonymized-store";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { detached } from "@/lib/detached";

type ChatTitleSuggestButtonProps = {
  anonymized: boolean;
  hasMessages: boolean;
  isPending: boolean;
  /**
   * Fires on `click`, so keyboard activation works too. `onMouseDown` calls
   * `preventDefault()` (without triggering) so the button also works inside
   * `InlineEdit`'s `action` slot, where a pointer press's focus steal would
   * otherwise blur-commit the editor before the suggestion could land; the
   * prevented press still emits the `click`.
   */
  onTrigger: () => void;
  className?: string | undefined;
};

/**
 * The magic-wand "suggest a title" trigger, shared by every rename surface
 * (rename editors, the inspector tab header, threads-sheet rows) so the
 * icon, pending spinner, and disabled explanations stay identical.
 */
export const ChatTitleSuggestButton = ({
  anonymized,
  hasMessages,
  isPending,
  onTrigger,
  className,
}: ChatTitleSuggestButtonProps) => {
  const t = useTranslations();

  let label = t("chat.suggestTitle");
  if (!hasMessages) {
    label = t("chat.renameUnavailableEmptyThread");
  }
  if (anonymized) {
    label = t("chat.suggestTitleUnavailableAnonymized");
  }
  if (isPending) {
    label = t("chat.suggestingTitle");
  }

  return (
    <Tooltip
      content={label}
      render={
        <Button
          aria-label={label}
          className={cn(
            "text-muted-foreground hover:text-foreground shrink-0",
            className,
          )}
          disabled={anonymized || !hasMessages || isPending}
          onClick={onTrigger}
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          {isPending ? (
            <Loader2Icon aria-hidden="true" className="size-3.5 animate-spin" />
          ) : (
            <WandSparklesIcon aria-hidden="true" className="size-3.5" />
          )}
        </Button>
      }
    />
  );
};

type ChatTitleRenameViewProps = {
  /** Committed title with the localized "New chat" fallback applied. */
  displayTitle: string;
  isSuggesting: boolean;
  /** Opens the inline editor seeded with the committed title. */
  startEditing: () => void;
  /** Opens the inline editor and requests one suggestion into the draft. */
  startEditingWithSuggestion: () => void;
};

type ChatTitleRenameProps = {
  threadRef: ChatThreadRef;
  /**
   * Committed title resolved by the surface ("" while it is still the
   * placeholder). The surface supplies it because each already has the
   * cheapest source at hand (grouped-threads cache, list row, primed query).
   */
  title: string;
  /** Whether the thread has at least one persisted message; gates the wand. */
  hasMessages: boolean;
  /**
   * Whether this instance consumes `/rename-chat` requests from the command
   * store. Exactly one mounted instance per thread may own the command (the
   * breadcrumb on the chat route, the title slot on the file-chat overlay);
   * list rows and other secondary mounts must pass false so they cannot
   * race the owner for the same request.
   */
  ownsRenameCommand: boolean;
  /**
   * Surface-specific view-mode content. Defaults to the click-to-edit title
   * button the breadcrumb established. The threads sheet substitutes its
   * navigation row and triggers editing from its own wand.
   */
  renderView?:
    | ((view: ChatTitleRenameViewProps) => React.JSX.Element)
    | undefined;
  inputClassName?: string | undefined;
  /** Class for the `InlineEdit` wrapper (e.g. to fill a list row). */
  editClassName?: string | undefined;
};

/**
 * The one rename-with-suggestion affordance for chat threads: a view-mode
 * trigger, the `InlineEdit` editor with the suggest wand in its action
 * slot, the rename mutation, and the `/rename-chat` command subscription.
 * Every surface that renames a conversation mounts this component, so the
 * behaviour (stale-draft guard, wand gating, commit semantics) cannot
 * diverge between them.
 */
export const ChatTitleRename = ({
  threadRef,
  title,
  hasMessages,
  ownsRenameCommand,
  renderView,
  inputClassName,
  editClassName,
}: ChatTitleRenameProps) => {
  const t = useTranslations();
  const anonymized = useChatAnonymized(threadRef);
  const rename = useRenameChatThread(threadRef);
  const { suggest, isPending: isSuggesting } =
    useSuggestChatThreadTitle(threadRef);
  const inlineRename = useInlineRename({
    initial: title,
    onCommit: (value) => {
      rename.mutate(value);
    },
  });

  // Mirrors of the edit session, maintained at the event handlers below (the
  // only entry and exit points), so the async suggestion callback can tell
  // whether the user typed, cancelled, or committed while the request was in
  // flight without reading stale closure state.
  const draftRef = useRef<string | null>(null);
  const sessionRef = useRef(0);

  // `useLatestCallback` on the view-facing triggers: they mutate the session
  // mirrors (refs), which must only happen from events, and the stable
  // wrapper is what lets `renderView` receive them during render.
  const startEditing = useLatestCallback(() => {
    sessionRef.current += 1;
    draftRef.current = title;
    inlineRename.startEditing();
  });

  const suggestIntoDraft = async () => {
    const session = sessionRef.current;
    const baseline = draftRef.current;
    const suggestion = await suggest();
    if (suggestion === null) {
      return;
    }
    // Stale-draft guard (same rule as `ChatPromptImproveButton`): apply only
    // when the editor is still in the same edit session and the user has not
    // typed since the request started; otherwise drop the suggestion rather
    // than clobber their input.
    if (sessionRef.current !== session || draftRef.current !== baseline) {
      return;
    }
    draftRef.current = suggestion;
    inlineRename.setDraft(suggestion);
  };

  const startEditingWithSuggestion = useLatestCallback(() => {
    startEditing();
    // The wand's disabled states, re-checked here because this trigger is
    // also reachable through `/rename-chat`: an anonymized thread refuses
    // suggestions (server-enforced with a 403), and a message-less thread
    // has nothing to summarize. Open the plain editor instead of firing a
    // doomed request; the disabled wand inside it explains why.
    if (anonymized || !hasMessages) {
      return;
    }
    detached(suggestIntoDraft(), "ChatTitleRename");
  });

  // `/rename-chat` handoff: a composer records the request in the command
  // store; the mounted rename owner for that thread consumes it. A request
  // carrying a title (`/rename-chat <title>`) commits directly through the
  // rename mutation; a bare one opens the editor with a suggestion.
  const consumeRenameRequest = useLatestCallback(() => {
    const store = useChatRenameCommandStore.getState();
    const pending = store.pendingRename;
    if (pending?.threadId !== threadRef.threadId) {
      return;
    }
    store.clearRenameRequest();
    if (pending.title !== null) {
      rename.mutate(pending.title);
      return;
    }
    startEditingWithSuggestion();
  });
  useMountEffect(() => {
    if (!ownsRenameCommand) {
      return undefined;
    }
    consumeRenameRequest();
    return useChatRenameCommandStore.subscribe(consumeRenameRequest);
  });

  if (inlineRename.state.mode === "edit") {
    return (
      <InlineEdit
        action={
          <ChatTitleSuggestButton
            anonymized={anonymized}
            hasMessages={hasMessages}
            isPending={isSuggesting}
            onTrigger={() => {
              detached(suggestIntoDraft(), "ChatTitleRename");
            }}
          />
        }
        className={editClassName}
        inputClassName={inputClassName}
        onCancel={() => {
          sessionRef.current += 1;
          draftRef.current = null;
          inlineRename.cancel();
        }}
        onChange={(value) => {
          draftRef.current = value;
          inlineRename.setDraft(value);
        }}
        onCommit={() => {
          sessionRef.current += 1;
          draftRef.current = null;
          detached(inlineRename.commit(), "ChatTitleRename");
        }}
        value={inlineRename.state.draft}
      />
    );
  }

  const displayTitle = title.length > 0 ? title : t("chat.newChat");
  const view: ChatTitleRenameViewProps = {
    displayTitle,
    isSuggesting,
    startEditing,
    startEditingWithSuggestion,
  };

  if (renderView) {
    return renderView(view);
  }

  return (
    <Tooltip
      content={t("chat.renameThread")}
      render={
        <button
          className="hover:bg-accent hover:text-accent-foreground -mx-1 flex min-w-0 items-center rounded-sm px-1 py-0.5 transition-colors"
          onClick={startEditing}
          type="button"
        >
          <BidiText as="span" className="max-w-64 truncate">
            {displayTitle}
          </BidiText>
        </button>
      }
    />
  );
};
