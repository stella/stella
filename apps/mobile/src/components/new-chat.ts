import { randomUUID } from "expo-crypto";
import { useRouter } from "expo-router";
import { useTranslations } from "use-intl";

import { useLayout, useSelection } from "@/components/selection";

/**
 * Opens an empty thread under a new id, beside the chats where the window
 * has two columns. The server creates the thread with its first message,
 * so nothing is written until something is sent.
 */
export const useNewChat = (): (() => void) => {
  const t = useTranslations("chat");
  const router = useRouter();
  const layout = useLayout();
  const selection = useSelection();

  return () => {
    if (layout.usesSplitView) {
      selection.select("thread", {
        fresh: true,
        threadId: randomUUID(),
        title: t("newChat"),
      });
      return;
    }
    router.push({
      pathname: "/thread/[threadId]",
      params: { fresh: "1", threadId: randomUUID(), title: t("newChat") },
    });
  };
};
