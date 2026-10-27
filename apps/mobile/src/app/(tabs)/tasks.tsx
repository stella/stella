import { useTranslations } from "use-intl";

import { EmptyStateScreen } from "@/components/empty-state-screen";

const TasksScreen = () => {
  const t = useTranslations("tasks");

  return (
    <EmptyStateScreen
      emptyDescription={t("emptyDescription")}
      emptyTitle={t("emptyTitle")}
    />
  );
};

export default TasksScreen;
