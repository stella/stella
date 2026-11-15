import { Suspense, useTransition } from "react";

import { Result } from "better-result";
import { useTimeZone } from "use-intl";

import { Loader } from "@stll/ui/loader";

import { useRevisedLoad } from "@/components/changes";
import { LoadedTasks } from "@/components/loaded-tasks";
import { epochMilliseconds } from "@/connection/clock";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import {
  applyTasksPage,
  dayAt,
  listTasks,
  NO_TASKS_LOADED,
} from "@/state/tasks";
import type { TasksLoad, TasksView } from "@/state/tasks";

/**
 * The tasks `view` asks for, loaded once, again on every pull to refresh,
 * after a task changes anywhere in the app, and afresh for another view;
 * a long list loads a page at a time.
 */
export const TasksList = ({
  showMatter,
  source,
  view,
}: {
  /** Whether each row names its matter: not in a matter's own list. */
  showMatter: boolean;
  source: AccessTokenSource;
  view: TasksView;
}) => (
  <TasksLoader
    // Another view is another list.
    key={JSON.stringify([view.whose, view.show, view.matterId])}
    showMatter={showMatter}
    source={source}
    view={view}
  />
);

const TasksLoader = ({
  showMatter,
  source,
  view,
}: {
  showMatter: boolean;
  source: AccessTokenSource;
  view: TasksView;
}) => {
  const { end } = useSession();
  const timeZone = useTimeZone() ?? "UTC";
  // A session the server ended sends the person back to sign in, from the
  // load itself rather than from a render.
  const loadPage = async (previous: TasksLoad): Promise<TasksLoad> => {
    const now = epochMilliseconds();
    const page = await listTasks({
      cursor: previous.nextCursor,
      fetch,
      source,
      // Overdue means before the day the list was first loaded on.
      today: dayAt(
        previous.tasks.length === 0 ? now : previous.loadedAt,
        timeZone,
      ),
      view,
    });
    if (Result.isError(page) && page.error._tag === "SignedOutError") {
      end(source);
    }
    return applyTasksPage(previous, page, now);
  };
  const [load, setLoad] = useRevisedLoad(
    async () => await loadPage(NO_TASKS_LOADED),
    ["tasks"],
  );
  const [refreshing, startRefresh] = useTransition();
  const [loadingMore, startLoadMore] = useTransition();
  const reload = () => {
    startRefresh(() => {
      setLoad(loadPage(NO_TASKS_LOADED));
    });
  };
  const loadMore = (current: TasksLoad) => {
    startLoadMore(() => {
      setLoad(loadPage(current));
    });
  };

  return (
    <Suspense fallback={<Loader className="flex-1" />}>
      <LoadedTasks
        load={load}
        loadingMore={loadingMore}
        onLoadMore={loadMore}
        onReload={reload}
        refreshing={refreshing}
        showMatter={showMatter}
        source={source}
        view={view}
      />
    </Suspense>
  );
};
