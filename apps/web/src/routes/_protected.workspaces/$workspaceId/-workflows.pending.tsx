import type { ReactNode } from "react";

import { useSearch } from "@tanstack/react-router";

import { ScrollArea } from "@stll/ui/scroll-area";

import { PendingText } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";

import {
  RunDetailShell,
  RunDetailSkeleton,
} from "./-components/flows/run-detail.pending";
import { RunLauncherSkeleton } from "./-components/flows/run-launcher.pending";
import { RunsSkeleton } from "./-components/flows/runs-list.pending";

export const WorkflowsShell = ({
  launcher,
  history,
  feedback,
}: {
  launcher: ReactNode;
  history: ReactNode;
  feedback?: ReactNode;
}) => (
  <div className="flex h-full flex-col">
    {feedback}
    <header className="flex items-center justify-between border-b px-4 py-3">
      <h1 className="text-sm font-medium">
        <PendingText id="common.workflows" />
      </h1>
    </header>
    <ScrollArea axis="vertical" className="flex-1">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">
            <PendingText id="flows.runs.launch" />
          </h2>
          {launcher}
        </section>
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">
            <PendingText id="flows.runs.history" />
          </h2>
          {history}
        </section>
      </div>
    </ScrollArea>
  </div>
);

export const WorkflowsPending = framePendingView(() => {
  const run = useSearch({ strict: false, select: (search) => search.run });
  return run === undefined ? (
    <WorkflowsShell
      launcher={<RunLauncherSkeleton />}
      history={<RunsSkeleton />}
    />
  ) : (
    <RunDetailShell>
      <RunDetailSkeleton />
    </RunDetailShell>
  );
});
