import { useTranslations } from "use-intl";

import { EmptyStateScreen } from "@/components/empty-state-screen";

const ChatsScreen = () => {
  const t = useTranslations();

  return (
    <EmptyStateScreen
      description={t("chat.description")}
      emptyDescription={t("chat.emptyDescription")}
      emptyTitle={t("chat.emptyTitle")}
      title={t("tabs.chat")}
    />
  );
};

export default ChatsScreen;
