import { useTranslations } from "use-intl";

import { EmptyStateScreen } from "@/components/empty-state-screen";

const TasksScreen = () => {
  const t = useTranslations();

  return (
    <EmptyStateScreen
      description={t("tasks.description")}
      emptyDescription={t("tasks.emptyDescription")}
      emptyTitle={t("tasks.emptyTitle")}
      title={t("tabs.tasks")}
    />
  );
};

export default TasksScreen;
