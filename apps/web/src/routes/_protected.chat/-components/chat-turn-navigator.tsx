import { useTranslations } from "use-intl";

import { userMessageFallbackText } from "@/components/chat/chat-thread-messages.logic";
import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import Tooltip from "@/components/tooltip";
import { useStickToBottomContext } from "@/hooks/use-stick-to-bottom";
import { getLangDir, useI18nStore } from "@/i18n/i18n-store";
import { dedupeById } from "@/lib/dedupe-by-id";
import { buildChatTurnNavigationItems } from "@/routes/_protected.chat/-components/chat-turn-navigator.logic";

type ChatTurnNavigatorProps = {
  messages: PersistedChatMessage[];
};

export const ChatTurnNavigator = ({ messages }: ChatTurnNavigatorProps) => {
  const t = useTranslations();
  const lang = useI18nStore((state) => state.lang);
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
    ].find((candidate) => candidate.dataset["chatTurnId"] === turnId);
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
      className="absolute inset-s-4 top-1/2 z-20 hidden max-h-[calc(100dvh-12rem)] -translate-y-1/2 flex-col overflow-y-auto overscroll-contain py-2 @6xl:flex"
    >
      {navigationItems.map((item) => {
        const userPreview =
          item.userPreview ??
          (item.userAttachmentCount > 0
            ? t("chat.queuedAttachmentCount", {
                count: item.userAttachmentCount,
              })
            : t("chat.noPromptPresetOnly"));

        return (
          <Tooltip
            align="center"
            className="w-[min(36rem,calc(100vw-8rem))] max-w-none text-wrap"
            content={
              <div className="px-2 py-2">
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
            }
            key={item.id}
            render={
              <button
                aria-label={t("chat.jumpToMessage")}
                className="focus-visible:ring-ring group relative flex size-11 shrink-0 cursor-pointer items-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
                onClick={() => scrollToTurn(item.id)}
                type="button"
              />
            }
            side={getLangDir(lang) === "rtl" ? "left" : "right"}
          >
            <span
              aria-hidden="true"
              className="bg-muted-foreground/35 h-0.5 w-7 rounded-full"
            />
            <span
              aria-hidden="true"
              className="bg-foreground absolute h-0.5 w-10 rounded-full opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
            />
          </Tooltip>
        );
      })}
    </div>
  );
};
