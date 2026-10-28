import { View } from "react-native";

import { screenStyles } from "@/components/empty-state-screen";
import { TasksList } from "@/components/tasks-list";
import { useSession } from "@/connection/session-provider";
import { useAppColors } from "@/theme";

const TasksScreen = () => {
  const colors = useAppColors();
  const { state } = useSession();

  return (
    <View style={[screenStyles.screen, { backgroundColor: colors.background }]}>
      {state.status === "signed-in" ? (
        <TasksList source={state.source} />
      ) : null}
    </View>
  );
};

export default TasksScreen;
