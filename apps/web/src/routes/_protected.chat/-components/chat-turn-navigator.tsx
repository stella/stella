import { useTranslations } from "use-intl";

import { userMessageFallbackText } from "@/components/chat/chat-thread-messages.logic";
import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import { useStickToBottomContext } from "@/hooks/use-stick-to-bottom";
import { dedupeById } from "@/lib/dedupe-by-id";
import { buildChatTurnNavigationItems } from "@/routes/_protected.chat/-components/chat-turn-navigator.logic";

type ChatTurnNavigatorProps = {
  messages: PersistedChatMessage[];
};

export const ChatTurnNavigator = ({ messages }: ChatTurnNavigatorProps) => {
  const t = useTranslations();
  const { scrollElementRef } = useStickToBottomContext();
  const navigationItems = buildChatTurnNavigationItems(
    dedupeById(messages),
    userMessageFallbackText,
  );

  if (navigationItems.length < 2) {
    return null;
  }

  const scrollToTurn = (turnId: string) => {
    const container = scrollElementRef.current;
    if (!container) {
      return;
    }

    const turn = [
      ...container.querySelectorAll<HTMLElement>("[data-chat-turn-id]"),
    ].find((candidate) => candidate.dataset.chatTurnId === turnId);
    if (!turn) {
      return;
    }

    container.scrollTo({
      behavior: "smooth",
      top:
        container.scrollTop +
        turn.getBoundingClientRect().top -
        container.getBoundingClientRect().top,
    });
  };

  return (
    <div
      aria-live="off"
      className="absolute inset-s-4 top-1/2 z-20 hidden max-h-[calc(100dvh-12rem)] -translate-y-1/2 flex-col py-2 @6xl:flex"
    >
      {navigationItems.map((item) => {
        const tooltipId = `chat-turn-preview-${item.id}`;
        const userPreview =
          item.userPreview ??
          (item.userAttachmentCount > 0
            ? t("chat.queuedAttachmentCount", {
                count: item.userAttachmentCount,
              })
            : t("chat.noPromptPresetOnly"));

        return (
          <div
            className="group relative flex size-11 items-center"
            key={item.id}
          >
            <button
              aria-describedby={tooltipId}
              aria-label={t("chat.jumpToMessage")}
              className="focus-visible:ring-ring relative flex size-full cursor-pointer items-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
              onClick={() => scrollToTurn(item.id)}
              type="button"
            >
              <span
                aria-hidden="true"
                className="bg-muted-foreground/35 h-0.5 w-7 rounded-full"
              />
              <span
                aria-hidden="true"
                className="bg-foreground absolute h-0.5 w-10 rounded-full opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100"
              />
            </button>
            <div
              className="bg-popover text-popover-foreground pointer-events-none absolute start-full top-1/2 ms-3 w-[min(36rem,calc(100vw-8rem))] -translate-y-1/2 rounded-xl px-4 py-3 opacity-0 shadow-lg transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100"
              id={tooltipId}
              role="tooltip"
            >
              <p className="line-clamp-1 text-sm font-medium" dir="auto">
                {userPreview}
              </p>
              {item.assistantPreview && (
                <p
                  className="text-muted-foreground mt-1 line-clamp-2 text-sm leading-5"
                  dir="auto"
                >
                  {item.assistantPreview}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};
