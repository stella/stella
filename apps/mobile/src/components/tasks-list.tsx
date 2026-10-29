import { Suspense, useState, useTransition } from "react";

import { Result } from "better-result";

import { Loader } from "@stll/ui/loader";

import { useRevision } from "@/components/changes";
import { LoadedTasks } from "@/components/loaded-tasks";
import { epochMilliseconds } from "@/connection/clock";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import { listMyTasks } from "@/state/tasks";
import type { TasksLoad } from "@/state/tasks";

/**
 * The signed-in person's open tasks, loaded once, again on every pull to
 * refresh, and afresh after a task is added from the header's "+".
 */
export const TasksList = ({ source }: { source: AccessTokenSource }) => {
  const revision = useRevision("tasks");
  return <TasksLoader key={revision} source={source} />;
};

const TasksLoader = ({ source }: { source: AccessTokenSource }) => {
  const { end } = useSession();
  // A session the server ended sends the person back to sign in, from the
  // load itself rather than from a render.
  const loadTasks = async (): Promise<TasksLoad> => {
    const result = await listMyTasks({ fetch, source });
    if (Result.isError(result) && result.error._tag === "SignedOutError") {
      end(source);
    }
    return { loadedAt: epochMilliseconds(), result };
  };
  const [load, setLoad] = useState(loadTasks);
  const [refreshing, startRefresh] = useTransition();
  const reload = () => {
    startRefresh(() => {
      setLoad(loadTasks());
    });
  };

  return (
    <Suspense fallback={<Loader className="flex-1" />}>
      <LoadedTasks load={load} onReload={reload} refreshing={refreshing} />
    </Suspense>
  );
};
