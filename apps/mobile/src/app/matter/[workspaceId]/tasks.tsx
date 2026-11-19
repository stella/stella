import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useTranslations } from "use-intl";

import { useCan } from "@/components/role";
import { TasksList } from "@/components/tasks-list";
import { useTasksFilter, useTasksFilterMenu } from "@/components/tasks-view";
import { barGlyph } from "@/components/ui/bar-glyph";
import { useSession } from "@/connection/session-provider";

/**
 * One matter's tasks, as the web's matter task view lists them: everyone's
 * open tasks to begin with, the header's menu choosing whose and which, and
 * its "+" adding one to the matter where the person's role may.
 */
const MatterTasksScreen = () => {
  const { workspaceId } = useLocalSearchParams<{ workspaceId: string }>();
  const t = useTranslations("matter");
  const tasks = useTranslations("tasks");
  const router = useRouter();
  const { state } = useSession();
  const view = useTasksFilter({ whose: "everyone", show: "open" });
  const filterMenu = useTasksFilterMenu(view);
  const canAdd = useCan({ entity: ["create"] });

  return (
    <>
      <Stack.Screen options={{ title: t("tasks") }} />
      <Stack.Toolbar placement="right">
        {canAdd ? (
          <Stack.Toolbar.Button
            onPress={() => {
              router.push({
                pathname: "/task/new",
                params: { matterId: workspaceId },
              });
            }}
          >
            {barGlyph("plus")}
            <Stack.Toolbar.Label>{tasks("newTask")}</Stack.Toolbar.Label>
          </Stack.Toolbar.Button>
        ) : null}
        {filterMenu}
      </Stack.Toolbar>
      {state.status === "signed-in" ? (
        <TasksList
          showMatter={false}
          source={state.source}
          view={{
            matterId: workspaceId,
            show: view.show,
            whose: view.whose,
          }}
        />
      ) : null}
    </>
  );
};

export default MatterTasksScreen;
