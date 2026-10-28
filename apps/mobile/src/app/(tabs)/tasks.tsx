import { View } from "react-native";
import { useTranslations } from "use-intl";

import { TaskPane } from "@/components/detail-panes";
import { screenStyles } from "@/components/empty-state-screen";
import { useSelection } from "@/components/selection";
import { SplitPane } from "@/components/split-pane";
import { TasksList } from "@/components/tasks-list";
import { useSession } from "@/connection/session-provider";
import { useAppColors } from "@/theme";

const TasksScreen = () => {
  const colors = useAppColors();
  const { state } = useSession();
  const selection = useSelection();
  const t = useTranslations("tasks");

  return (
    <View style={[screenStyles.screen, { backgroundColor: colors.background }]}>
      {state.status === "signed-in" ? (
        <SplitPane
          detail={
            selection.task === null ? null : (
              <TaskPane key={selection.task.entityId} task={selection.task} />
            )
          }
          emptyDescription={t("pickDescription")}
          emptyTitle={t("pickTitle")}
          list={<TasksList source={state.source} />}
        />
      ) : null}
    </View>
  );
};

export default TasksScreen;
