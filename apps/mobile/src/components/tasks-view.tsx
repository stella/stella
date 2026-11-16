import { createContext, use, useState } from "react";

import { panic } from "better-result";
import { Stack } from "expo-router";
import { useTranslations } from "use-intl";

import { barGlyph } from "@/components/ui/bar-glyph";
import { TASK_SHOW, TASK_WHOSE } from "@/state/tasks";
import type { TaskShow, TaskWhose } from "@/state/tasks";

type TasksFilter = {
  readonly whose: TaskWhose;
  readonly show: TaskShow;
};

export type TasksViewState = TasksFilter & {
  readonly setWhose: (whose: TaskWhose) => void;
  readonly setShow: (show: TaskShow) => void;
};

const TasksViewContext = createContext<TasksViewState | null>(null);

/** Which tasks a list shows, which its header's menu sets. */
export const useTasksFilter = (initial: TasksFilter): TasksViewState => {
  const [whose, setWhose] = useState(initial.whose);
  const [show, setShow] = useState(initial.show);
  return { setShow, setWhose, show, whose };
};

/**
 * The tasks tab's filter, shared by its header's menu and its list: the
 * person's own open tasks to begin with, as the tab always showed. It sits
 * above the tabs, so the choice holds on the way back to the list.
 */
export const TasksViewProvider = ({ children }: React.PropsWithChildren) => (
  <TasksViewContext value={useTasksFilter({ whose: "mine", show: "open" })}>
    {children}
  </TasksViewContext>
);

export const useTasksView = (): TasksViewState =>
  use(TasksViewContext) ??
  panic("useTasksView needs a TasksViewProvider above it");

/**
 * The header's filter menu, as the system's own apps set one: whose tasks
 * (the person's, everyone's they can see, or nobody's) and which (open,
 * overdue, or every one, finished ones included), each a section with its
 * choice ticked. An element, not a component: the bar reads its toolbar
 * items as they are written.
 */
export const useTasksFilterMenu = (view: TasksViewState) => {
  const t = useTranslations("tasks");
  return (
    <Stack.Toolbar.Menu title={t("filter")}>
      {barGlyph("sliders-horizontal")}
      <Stack.Toolbar.Menu inline title={t("whoseTitle")}>
        {TASK_WHOSE.map((whose) => (
          <Stack.Toolbar.MenuAction
            isOn={view.whose === whose}
            key={whose}
            onPress={() => {
              view.setWhose(whose);
            }}
          >
            {t(`whose.${whose}`)}
          </Stack.Toolbar.MenuAction>
        ))}
      </Stack.Toolbar.Menu>
      <Stack.Toolbar.Menu inline title={t("showTitle")}>
        {TASK_SHOW.map((show) => (
          <Stack.Toolbar.MenuAction
            isOn={view.show === show}
            key={show}
            onPress={() => {
              view.setShow(show);
            }}
          >
            {t(`show.${show}`)}
          </Stack.Toolbar.MenuAction>
        ))}
      </Stack.Toolbar.Menu>
    </Stack.Toolbar.Menu>
  );
};
