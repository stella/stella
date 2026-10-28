import { createContext, use, useState } from "react";

import { panic } from "better-result";

type TasksView = {
  /** Counts the tasks added or changed here, so the list loads afresh after each. */
  readonly revision: number;
  readonly tasksChanged: () => void;
};

const TasksViewContext = createContext<TasksView | null>(null);

/**
 * What the tasks list and the sheet that adds one share. It sits above the
 * tabs, so a task added from its sheet shows in the list underneath.
 */
export const TasksViewProvider = ({ children }: React.PropsWithChildren) => {
  const [revision, setRevision] = useState(0);
  const tasksChanged = () => {
    setRevision((current) => current + 1);
  };
  return (
    <TasksViewContext value={{ revision, tasksChanged }}>
      {children}
    </TasksViewContext>
  );
};

export const useTasksView = (): TasksView =>
  use(TasksViewContext) ??
  panic("useTasksView needs a TasksViewProvider above it");
