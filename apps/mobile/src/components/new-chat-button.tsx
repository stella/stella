import { randomUUID } from "expo-crypto";
import { useRouter } from "expo-router";
import { useTranslations } from "use-intl";

import { Button } from "@/components/ui/button";

/**
 * Opens an empty thread under a new id. The server creates the thread with
 * its first message, so nothing is written until something is sent.
 */
export const NewChatButton = () => {
  const t = useTranslations("chat");
  const router = useRouter();

  return (
    <Button
      label={t("newChat")}
      onPress={() => {
        router.push({
          pathname: "/thread/[threadId]",
          params: { fresh: "1", threadId: randomUUID(), title: t("newChat") },
        });
      }}
    />
  );
};
