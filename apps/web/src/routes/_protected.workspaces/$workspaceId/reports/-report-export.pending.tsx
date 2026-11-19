import type { ReactNode } from "react";

import { ScrollArea } from "@stll/ui/scroll-area";
import { Skeleton } from "@stll/ui/skeleton";

import { PendingText } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";

export const ReportExportRecoveryShell = ({
  children,
}: {
  children: ReactNode;
}) => (
  <main className="flex h-full flex-col">
    <header className="border-b px-4 py-3">
      <h1 className="text-sm font-medium">
        <PendingText id="workspaces.views.reportExport.title" />
      </h1>
    </header>
    <ScrollArea axis="vertical" className="flex-1">
      <div className="p-6">
        <section
          aria-live="polite"
          className="mx-auto flex max-w-lg flex-col gap-3 rounded-lg border p-5"
        >
          {children}
        </section>
      </div>
    </ScrollArea>
  </main>
);

export const ReportExportRecoveryPending = framePendingView(() => (
  <ReportExportRecoveryShell>
    <h2 className="font-medium">
      <Skeleton className="h-[1lh] w-32" />
    </h2>
  </ReportExportRecoveryShell>
));
